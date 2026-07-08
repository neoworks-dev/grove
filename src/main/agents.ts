// Agent launcher. Agents are named command adapters (claude -p, codex exec, ...).
// Launching = spawn the configured command with cwd = worktree, capture output,
// stream to the Agent pane + a log file. Replaceable backends, no Claude-specific
// coupling. Multiple worktrees may run agents concurrently.

import { spawn, execFile, type ChildProcess } from 'child_process'
import { createWriteStream, type WriteStream } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AgentConfig, AgentOption, AgentRuntime, Worktree } from '../shared/types'
import { buildWorktreeEnv, substitute, spawnEnv } from './env'

// Adapter for a known agent CLI. `command` is the non-interactive invocation.
// `modelsCommand` (when the CLI can list models) is run to discover models
// dynamically; `modelFlag` builds the CLI arg for a chosen model. `modes` and
// `efforts` are the adapter's fixed capabilities. Everything is overridable via
// workbench.yaml (config wins on name collision).
interface KnownAgent {
  name: string
  bin: string
  command: string
  modelsCommand?: string[]
  modelFlag?: string // default '--model {value}'
  modes?: AgentOption[]
  efforts?: AgentOption[]
}

const KNOWN_AGENTS: KnownAgent[] = [
  {
    name: 'claude',
    bin: 'claude',
    // stream-json emits one complete JSON event per line (no partial-message
    // duplication) and exposes tool calls so the UI can render command cards.
    command: 'claude -p --output-format stream-json --verbose',
    modes: [
      { label: 'manual review', flag: '--permission-mode default' },
      { label: 'plan', flag: '--permission-mode plan' },
      { label: 'accept edits', flag: '--permission-mode acceptEdits' },
      { label: 'auto', flag: '--permission-mode bypassPermissions' }
    ],
    efforts: [
      { label: 'default', flag: '' },
      { label: 'low', flag: '--effort low' },
      { label: 'medium', flag: '--effort medium' },
      { label: 'high', flag: '--effort high' },
      { label: 'xhigh', flag: '--effort xhigh' },
      { label: 'max', flag: '--effort max' }
    ]
  },
  {
    name: 'codex',
    bin: 'codex',
    command: 'codex exec',
    modes: [
      { label: 'manual review', flag: '--ask-for-approval on-request' },
      { label: 'auto', flag: '--full-auto' }
    ],
    efforts: [
      { label: 'default', flag: '' },
      { label: 'low', flag: '-c model_reasoning_effort=low' },
      { label: 'medium', flag: '-c model_reasoning_effort=medium' },
      { label: 'high', flag: '-c model_reasoning_effort=high' }
    ]
  },
  {
    name: 'opencode',
    bin: 'opencode',
    command: 'opencode run',
    modelsCommand: ['models'] // `opencode models` lists available models
  },
  { name: 'gemini', bin: 'gemini', command: 'gemini -p' },
  { name: 'aider', bin: 'aider', command: 'aider --message' },
  { name: 'cursor-agent', bin: 'cursor-agent', command: 'cursor-agent' }
]

// True if a binary is resolvable on PATH.
function onPath(bin: string): Promise<boolean> {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(locator, [bin], (error) => resolve(!error))
  })
}

// Run an agent's model-list command and return one AgentOption per model.
function discoverModels(agent: KnownAgent): Promise<AgentOption[]> {
  if (!agent.modelsCommand) return Promise.resolve([])
  const template = agent.modelFlag || '--model {value}'
  return new Promise((resolve) => {
    execFile(
      agent.bin,
      agent.modelsCommand!,
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout) return resolve([])
        const models = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.includes(' '))
        resolve(models.map((value) => ({ label: value, flag: template.replace('{value}', value) })))
      }
    )
  })
}

let detectionCache: Record<string, AgentConfig> | null = null

// Detect installed CLIs and describe each: command, dynamically discovered
// models, and adapter modes/efforts. Cached — PATH and model lists are stable
// within a session.
export async function detectAgents(force = false): Promise<Record<string, AgentConfig>> {
  if (detectionCache && !force) return detectionCache
  const found: Record<string, AgentConfig> = {}
  await Promise.all(
    KNOWN_AGENTS.map(async (agent) => {
      if (!(await onPath(agent.bin))) return
      const models = await discoverModels(agent)
      const config: AgentConfig = { command: agent.command }
      if (models.length) config.models = models
      if (agent.modes) config.modes = agent.modes
      if (agent.efforts) config.efforts = agent.efforts
      found[agent.name] = config
    })
  )
  detectionCache = found
  return found
}

// Effective agents = auto-detected CLIs overlaid with config entries.
// Config wins so a user can override the command/options or add unknown agents.
export function mergeAgents(
  detected: Record<string, AgentConfig>,
  configured: Record<string, AgentConfig>
): Record<string, AgentConfig> {
  return { ...detected, ...configured }
}

export interface AgentEvents {
  onStatus: (runtime: AgentRuntime) => void
  onLog: (worktreeId: string, name: string, line: string) => void
}

interface RunningAgent {
  child: ChildProcess
  logStream: WriteStream
  runtime: AgentRuntime
}

function logsDir(worktreePath: string): string {
  return join(worktreePath, '.workbench', 'logs')
}

export class AgentManager {
  private running = new Map<string, RunningAgent>()

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

  // Launch an agent. `prompt` is appended as a single quoted argument when given.
  async start(
    worktree: Worktree,
    name: string,
    agent: AgentConfig,
    ports: number[],
    prompt?: string,
    extraArgs = ''
  ): Promise<AgentRuntime> {
    await this.stop(worktree.id, name)

    const vars = buildWorktreeEnv(worktree, ports)
    let command = substitute(agent.command, vars)
    if (extraArgs.trim().length > 0) {
      command = `${command} ${extraArgs.trim()}`
    }
    if (prompt && prompt.trim().length > 0) {
      command = `${command} ${shellQuote(prompt)}`
    }

    const dir = logsDir(worktree.path)
    await mkdir(dir, { recursive: true })
    const logPath = join(dir, `agent-${name}.log`)
    await writeFile(logPath, '', 'utf8').catch(() => {})
    const logStream = createWriteStream(logPath, { flags: 'a' })

    // stdin is ignored so CLIs that probe it (e.g. `claude -p`) don't stall
    // waiting for piped input — the prompt is passed as an argument instead.
    const child = spawn(command, {
      cwd: worktree.path,
      env: spawnEnv(vars),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const runtime: AgentRuntime = {
      worktreeId: worktree.id,
      name,
      status: 'running',
      pid: child.pid ?? null,
      command,
      exitCode: null,
      logPath
    }

    const entry: RunningAgent = { child, logStream, runtime }
    this.running.set(this.key(worktree.id, name), entry)

    const handle = (buffer: Buffer): void => {
      const text = buffer.toString()
      entry.logStream.write(text)
      text
        .split('\n')
        .filter((line) => line.length > 0)
        .forEach((line) => this.events.onLog(worktree.id, name, line))
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)

    child.on('exit', (code) => this.handleExit(worktree.id, name, code))
    child.on('error', (err) => {
      this.events.onLog(worktree.id, name, `[agent] spawn error: ${err.message}`)
      const active = this.running.get(this.key(worktree.id, name))
      if (active) active.runtime.status = 'error'
      this.handleExit(worktree.id, name, 1)
    })

    this.events.onStatus({ ...runtime })
    return { ...runtime }
  }

  private handleExit(worktreeId: string, name: string, code: number | null): void {
    const entry = this.running.get(this.key(worktreeId, name))
    if (!entry) return
    entry.logStream.end()
    entry.runtime.exitCode = code
    if (entry.runtime.status !== 'error') {
      entry.runtime.status = code === 0 ? 'exited' : 'error'
    }
    entry.runtime.pid = null
    this.events.onStatus({ ...entry.runtime })
    this.running.delete(this.key(worktreeId, name))
  }

  async stop(worktreeId: string, name: string): Promise<void> {
    const entry = this.running.get(this.key(worktreeId, name))
    if (!entry) return
    const pid = entry.child.pid
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already dead
      }
    }
  }

  // Which worktrees currently have at least one running agent.
  activeWorktreeIds(): string[] {
    const ids = new Set<string>()
    for (const key of this.running.keys()) {
      ids.add(key.split('::')[0])
    }
    return [...ids]
  }

  async stopAll(): Promise<void> {
    for (const key of [...this.running.keys()]) {
      const [worktreeId, name] = key.split('::')
      await this.stop(worktreeId, name)
    }
  }
}

// Minimal POSIX single-quote escaping for passing a prompt as one argument.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
