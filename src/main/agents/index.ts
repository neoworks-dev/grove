// Agent manager. Owns the adapter registry (claude/codex/opencode), runs one
// agent per (worktree, name), streams normalized output + status to IPC, and
// bridges interactive tool-permission requests between adapters and the user.

import { createWriteStream, type WriteStream } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  AgentConfig,
  AgentLaunchOptions,
  AgentRuntime,
  AgentStatus,
  PermissionDecision,
  PermissionRequestEvent,
  Worktree
} from '../../shared/types'
import type { AgentAdapter, RunHandle } from './types'
import { userPromptLine } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { opencodeAdapter } from './opencode'

const ADAPTERS: AgentAdapter[] = [claudeAdapter, codexAdapter, opencodeAdapter]
const registry = new Map<string, AgentAdapter>(ADAPTERS.map((adapter) => [adapter.name, adapter]))

// All adapters are available (SDKs are bundled); each declares its own config.
export function detectAgents(): Record<string, AgentConfig> {
  const configs: Record<string, AgentConfig> = {}
  for (const adapter of registry.values()) configs[adapter.name] = adapter.config
  return configs
}

// Effective agents = adapter defaults overlaid with repo config (config wins).
export function mergeAgents(
  detected: Record<string, AgentConfig>,
  configured: Record<string, AgentConfig>
): Record<string, AgentConfig> {
  return { ...detected, ...configured }
}

export interface AgentEvents {
  onStatus: (runtime: AgentRuntime) => void
  onLog: (worktreeId: string, name: string, line: string) => void
  onPermission: (request: PermissionRequestEvent) => void
}

interface RunningAgent {
  handle: RunHandle
  logStream: WriteStream
  runtime: AgentRuntime
  pendingPermissions: Set<string>
}

function logsDir(worktreePath: string): string {
  return join(worktreePath, '.workbench', 'logs')
}

export class AgentManager {
  private running = new Map<string, RunningAgent>()
  private permissionResolvers = new Map<string, (decision: PermissionDecision) => void>()
  private permissionSeq = 0

  constructor(private events: AgentEvents) {}

  private key(worktreeId: string, name: string): string {
    return `${worktreeId}::${name}`
  }

  getRuntime(worktreeId: string, name: string): AgentRuntime | null {
    return this.running.get(this.key(worktreeId, name))?.runtime ?? null
  }

  isRunning(worktreeId: string, name: string): boolean {
    return this.running.has(this.key(worktreeId, name))
  }

  async start(
    worktree: Worktree,
    name: string,
    _agent: AgentConfig,
    ports: number[],
    options: AgentLaunchOptions
  ): Promise<AgentRuntime> {
    await this.stop(worktree.id, name)
    const adapter = registry.get(name)
    if (!adapter) throw new Error(`unknown agent: ${name}`)

    const dir = logsDir(worktree.path)
    await mkdir(dir, { recursive: true })
    const logPath = join(dir, `agent-${name}.log`)
    await writeFile(logPath, '', 'utf8').catch(() => {})
    const logStream = createWriteStream(logPath, { flags: 'a' })

    const runtime: AgentRuntime = {
      worktreeId: worktree.id,
      name,
      status: 'running',
      pid: null,
      command: adapter.config.command,
      exitCode: null,
      logPath
    }

    const key = this.key(worktree.id, name)
    const entry: RunningAgent = {
      handle: { stop: async () => {} },
      logStream,
      runtime,
      pendingPermissions: new Set()
    }
    this.running.set(key, entry)

    const emit = (line: string): void => {
      logStream.write(line + '\n')
      this.events.onLog(worktree.id, name, line)
    }
    // Echo the user's prompt first so it opens the transcript as a chat message.
    if (options.prompt && options.prompt.trim()) emit(userPromptLine(options.prompt.trim()))

    entry.handle = adapter.start({
      worktree,
      ports,
      options,
      emit,
      setStatus: (status, exitCode) => this.handleStatus(worktree.id, name, status, exitCode ?? null),
      requestPermission: (request) => this.requestPermission(worktree.id, name, request)
    })

    this.events.onStatus({ ...runtime })
    return { ...runtime }
  }

  private requestPermission(
    worktreeId: string,
    name: string,
    request: Omit<PermissionRequestEvent, 'id'>
  ): Promise<PermissionDecision> {
    const id = `${this.key(worktreeId, name)}::perm${++this.permissionSeq}`
    const entry = this.running.get(this.key(worktreeId, name))
    entry?.pendingPermissions.add(id)
    this.events.onPermission({ id, ...request })
    return new Promise((resolve) => {
      this.permissionResolvers.set(id, resolve)
    })
  }

  respondPermission(id: string, decision: PermissionDecision): void {
    const resolve = this.permissionResolvers.get(id)
    if (!resolve) return
    this.permissionResolvers.delete(id)
    for (const entry of this.running.values()) entry.pendingPermissions.delete(id)
    resolve(decision)
  }

  private handleStatus(
    worktreeId: string,
    name: string,
    status: AgentStatus,
    exitCode: number | null
  ): void {
    const entry = this.running.get(this.key(worktreeId, name))
    if (!entry) return
    entry.runtime.status = status
    entry.runtime.exitCode = exitCode
    entry.runtime.pid = null

    if (status === 'running') {
      this.events.onStatus({ ...entry.runtime })
      return
    }
    // Terminal: auto-deny any still-pending permission and clean up.
    this.denyPending(entry)
    entry.logStream.end()
    this.events.onStatus({ ...entry.runtime })
    this.running.delete(this.key(worktreeId, name))
  }

  private denyPending(entry: RunningAgent): void {
    for (const id of entry.pendingPermissions) {
      const resolve = this.permissionResolvers.get(id)
      if (resolve) {
        this.permissionResolvers.delete(id)
        resolve({ behavior: 'deny', message: 'Agent stopped' })
      }
    }
    entry.pendingPermissions.clear()
  }

  async stop(worktreeId: string, name: string): Promise<void> {
    const entry = this.running.get(this.key(worktreeId, name))
    if (!entry) return
    this.denyPending(entry)
    await entry.handle.stop().catch(() => {})
  }

  activeWorktreeIds(): string[] {
    const ids = new Set<string>()
    for (const key of this.running.keys()) ids.add(key.split('::')[0])
    return [...ids]
  }

  async stopAll(): Promise<void> {
    for (const key of [...this.running.keys()]) {
      const [worktreeId, name] = key.split('::')
      await this.stop(worktreeId, name)
    }
  }
}
