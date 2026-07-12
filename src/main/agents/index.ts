// Agent manager. Owns the adapter registry (claude/codex/opencode), runs one
// agent per (worktree, name), streams normalized output + status to IPC, and
// bridges interactive tool-permission requests between adapters and the user.

import { createWriteStream, type WriteStream } from 'fs'
import { mkdir, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  AgentChats,
  AgentCommandsEvent,
  AgentConfig,
  AgentDialogDecision,
  AgentDialogRequest,
  AgentLaunchOptions,
  AgentQueueEvent,
  AgentRuntime,
  AgentSendResult,
  AgentSlashCommand,
  AgentStatus,
  ChatMeta,
  PermissionDecision,
  PermissionRequestEvent,
  QueuedMessage,
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
  // A blocking dialog (e.g. an agent question) awaiting the user's answer.
  onDialog?: (request: AgentDialogRequest) => void
  // Continuation token changed (empty string = conversation reset). Lets ipc
  // mirror it into persisted repo state so chats survive restarts.
  onSession?: (worktreeId: string, name: string, token: string) => void
  // Queued-message list changed (message queued, cancelled, drained, cleared).
  onQueue?: (event: AgentQueueEvent) => void
  // Provider-discovered slash commands changed.
  onCommands?: (event: AgentCommandsEvent) => void
  // Plugin AI contributions passed through to adapters (MCP servers + skills).
  pluginAi?: {
    mcpServers: () => Promise<Record<string, unknown>>
    systemAppend: () => string
  }
}

// Cap transcript replay so a very long conversation can't flood the renderer.
const MAX_TRANSCRIPT_LINES = 4000

interface RunningAgent {
  handle: RunHandle
  logStream: WriteStream
  runtime: AgentRuntime
  pendingPermissions: Set<string>
  pendingDialogs: Set<string>
  // Monotonic run marker: late setStatus/emit callbacks from a replaced run
  // must not touch the entry of the run that superseded it.
  runId: number
  // Set by an explicit user stop so the terminal handler flushes the queue
  // instead of auto-submitting what the user just interrupted.
  clearQueueOnStop: boolean
}

// Everything needed to start a follow-up run with the same configuration —
// recorded per key so queued messages can auto-submit when the run ends.
interface LastLaunch {
  worktree: Worktree
  agent: AgentConfig
  ports: number[]
  options: AgentLaunchOptions
}

function logsDir(worktreePath: string): string {
  return join(worktreePath, '.workbench', 'logs')
}

export class AgentManager {
  private running = new Map<string, RunningAgent>()
  private permissionResolvers = new Map<string, (decision: PermissionDecision) => void>()
  private permissionSeq = 0
  private dialogResolvers = new Map<string, (decision: AgentDialogDecision) => void>()
  private dialogSeq = 0
  // Named chats per (worktree, agent). Each carries its own continuation token
  // and transcript file, so a worktree holds several resumable conversations.
  private chats = new Map<string, AgentChats>()
  // Messages typed while a run is active that could not be injected live.
  // Survives run teardown; drained into a follow-up run on clean exit.
  private queues = new Map<string, QueuedMessage[]>()
  // Provider-discovered slash commands per (worktree, agent).
  private commands = new Map<string, AgentSlashCommand[]>()
  private lastLaunch = new Map<string, LastLaunch>()
  private runSeq = 0

  // `adapters` is injectable for tests; production uses the module registry.
  constructor(
    private events: AgentEvents,
    private adapters: Map<string, AgentAdapter> = registry
  ) {}

  private key(worktreeId: string, name: string): string {
    return `${worktreeId}::${name}`
  }

  // ── Named chats ────────────────────────────────────────────────
  loadChats(map: Record<string, AgentChats>): void {
    this.chats = new Map(
      Object.entries(map).map(([key, value]) => [
        key,
        { activeId: value.activeId, chats: value.chats.map((chat) => ({ ...chat })) }
      ])
    )
  }

  // Migrate legacy single-token sessions into a default 'legacy' chat (whose
  // transcript still lives in the old agent-<name>.log file). Only fills keys
  // that have no chats yet, so loadChats stays authoritative.
  loadSessions(map: Record<string, string>): void {
    for (const [key, token] of Object.entries(map)) {
      if (this.chats.has(key)) continue
      this.chats.set(key, {
        activeId: 'legacy',
        chats: [{ id: 'legacy', name: 'Chat 1', session: token, createdAt: 0, updatedAt: 0 }]
      })
    }
  }

  allChats(): Record<string, AgentChats> {
    return Object.fromEntries(this.chats.entries())
  }

  // Restore last-known discovered slash commands so the menu is populated
  // before the first run of this session refreshes them.
  loadCommands(map: Record<string, AgentSlashCommand[]>): void {
    for (const [key, commands] of Object.entries(map)) {
      if (!this.commands.has(key)) this.commands.set(key, commands)
    }
  }

  allCommands(): Record<string, AgentSlashCommand[]> {
    return Object.fromEntries(this.commands.entries())
  }

  private ensureChats(key: string): AgentChats {
    let entry = this.chats.get(key)
    if (!entry || entry.chats.length === 0) {
      const chat = this.newChat('Chat 1')
      entry = { activeId: chat.id, chats: [chat] }
      this.chats.set(key, entry)
    }
    return entry
  }

  private newChat(name: string): ChatMeta {
    const now = Date.now()
    return { id: randomUUID(), name, session: '', createdAt: now, updatedAt: now }
  }

  private activeChat(key: string): ChatMeta {
    const entry = this.ensureChats(key)
    return entry.chats.find((chat) => chat.id === entry.activeId) || entry.chats[0]
  }

  listChats(worktreeId: string, name: string): AgentChats {
    return this.ensureChats(this.key(worktreeId, name))
  }

  createChat(worktreeId: string, name: string, chatName?: string): ChatMeta {
    const key = this.key(worktreeId, name)
    const entry = this.ensureChats(key)
    const chat = this.newChat(chatName || `Chat ${entry.chats.length + 1}`)
    entry.chats.push(chat)
    entry.activeId = chat.id
    return chat
  }

  renameChat(worktreeId: string, name: string, chatId: string, chatName: string): void {
    const entry = this.ensureChats(this.key(worktreeId, name))
    const chat = entry.chats.find((candidate) => candidate.id === chatId)
    if (!chat) return
    chat.name = chatName
    chat.updatedAt = Date.now()
  }

  activateChat(worktreeId: string, name: string, chatId: string): void {
    const entry = this.ensureChats(this.key(worktreeId, name))
    if (!entry.chats.some((chat) => chat.id === chatId)) return
    if (entry.activeId !== chatId) this.clearQueue(worktreeId, name, false)
    entry.activeId = chatId
  }

  private transcriptPath(worktreePath: string, name: string, chatId: string): string {
    const file = chatId === 'legacy' ? `agent-${name}.log` : `agent-${name}__${chatId}.log`
    return join(logsDir(worktreePath), file)
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
    agent: AgentConfig,
    ports: number[],
    options: AgentLaunchOptions,
    // Internal turns (e.g. /compact) suppress the prompt echo so the command
    // doesn't show up as a chat message in the transcript.
    echoPrompt = true
  ): Promise<AgentRuntime> {
    await this.stop(worktree.id, name)
    const adapter = this.adapters.get(name)
    if (!adapter) throw new Error(`unknown agent: ${name}`)

    const key = this.key(worktree.id, name)
    this.lastLaunch.set(key, { worktree, agent, ports, options })
    const chat = this.activeChat(key)
    const resume = chat.session || undefined

    const dir = logsDir(worktree.path)
    await mkdir(dir, { recursive: true })
    const logPath = this.transcriptPath(worktree.path, name, chat.id)
    // Only wipe the transcript for a fresh chat; resuming appends to it.
    if (!resume) await writeFile(logPath, '', 'utf8').catch(() => {})
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

    const runId = ++this.runSeq
    const entry: RunningAgent = {
      handle: { stop: async () => {} },
      logStream,
      runtime,
      pendingPermissions: new Set(),
      pendingDialogs: new Set(),
      runId,
      clearQueueOnStop: false
    }
    this.running.set(key, entry)

    // Drop callbacks from a replaced run: its async teardown can fire after the
    // successor registered, and must not write into the new run's entry/stream.
    const isCurrentRun = (): boolean => this.running.get(key)?.runId === runId

    const emit = (line: string): void => {
      if (!isCurrentRun()) return
      logStream.write(line + '\n')
      this.events.onLog(worktree.id, name, line)
    }
    // Echo the user's prompt first so it opens the transcript as a chat message.
    if (echoPrompt && options.prompt && options.prompt.trim()) {
      emit(userPromptLine(options.prompt.trim()))
    }

    entry.handle = adapter.start({
      worktree,
      ports,
      options,
      resume,
      emit,
      setStatus: (status, exitCode) => {
        if (!isCurrentRun()) return
        this.handleStatus(worktree.id, name, status, exitCode ?? null)
      },
      setSession: (token) => this.rememberSession(worktree.id, name, token),
      requestPermission: (request) => this.requestPermission(worktree.id, name, request),
      requestDialog: (request) => this.requestDialog(worktree.id, name, request),
      pluginAi: this.events.pluginAi,
      setCommands: (commands) => {
        this.commands.set(key, commands)
        this.events.onCommands?.({ worktreeId: worktree.id, name, commands })
      }
    })

    this.events.onStatus({ ...runtime })
    return { ...runtime }
  }

  // ── Mid-run sends + queue ──────────────────────────────────────
  // One entry point for "the user typed a message": inject into the live run
  // when the adapter supports it, queue it when it doesn't, or start a resumed
  // run when nothing is running.
  async send(
    worktree: Worktree,
    name: string,
    agent: AgentConfig,
    ports: number[],
    text: string
  ): Promise<AgentSendResult> {
    const key = this.key(worktree.id, name)
    const trimmed = text.trim()
    const entry = this.running.get(key)
    if (entry) {
      if (entry.handle.send?.(trimmed)) {
        // Echo like start() does so the injection shows as a chat message.
        const line = userPromptLine(trimmed)
        entry.logStream.write(line + '\n')
        this.events.onLog(worktree.id, name, line)
        return { delivered: 'injected' }
      }
      const item: QueuedMessage = { id: randomUUID(), text: trimmed, createdAt: Date.now() }
      const queue = this.queues.get(key) ?? []
      queue.push(item)
      this.queues.set(key, queue)
      this.emitQueue(worktree.id, name)
      return { delivered: 'queued', id: item.id }
    }
    const launch = this.lastLaunch.get(key)
    await this.start(worktree, name, agent, ports, {
      ...(launch?.options ?? {}),
      prompt: trimmed
    })
    return { delivered: 'started' }
  }

  getQueue(worktreeId: string, name: string): QueuedMessage[] {
    return [...(this.queues.get(this.key(worktreeId, name)) ?? [])]
  }

  cancelQueued(worktreeId: string, name: string, id: string): void {
    const key = this.key(worktreeId, name)
    const queue = this.queues.get(key)
    if (!queue) return
    const index = queue.findIndex((item) => item.id === id)
    if (index === -1) return
    queue.splice(index, 1)
    this.emitQueue(worktreeId, name)
  }

  getCommands(worktreeId: string, name: string): AgentSlashCommand[] {
    return [...(this.commands.get(this.key(worktreeId, name)) ?? [])]
  }

  private emitQueue(worktreeId: string, name: string, cleared?: QueuedMessage[]): void {
    const queue = [...(this.queues.get(this.key(worktreeId, name)) ?? [])]
    this.events.onQueue?.({ worktreeId, name, queue, cleared })
  }

  private clearQueue(worktreeId: string, name: string, restoreToUser: boolean): void {
    const key = this.key(worktreeId, name)
    const queue = this.queues.get(key) ?? []
    if (queue.length === 0) return
    this.queues.set(key, [])
    this.emitQueue(worktreeId, name, restoreToUser ? queue : undefined)
  }

  private rememberSession(worktreeId: string, name: string, token: string): void {
    if (!token) return
    const chat = this.activeChat(this.key(worktreeId, name))
    if (chat.session === token) return
    chat.session = token
    chat.updatedAt = Date.now()
    this.events.onSession?.(worktreeId, name, token)
  }

  // "/compact": summarize the active chat and continue from a compacted
  // context, like Claude Code's compact command. Runs a `/compact` turn on the
  // resumed session; the CLI emits a compact_boundary and a new session id that
  // rememberSession captures for the next real prompt. Optional `instructions`
  // steer what the summary should focus on.
  async compact(
    worktree: Worktree,
    name: string,
    agent: AgentConfig,
    ports: number[],
    instructions?: string
  ): Promise<AgentRuntime> {
    const focus = (instructions || '').trim()
    const prompt = focus ? `/compact ${focus}` : '/compact'
    return this.start(worktree, name, agent, ports, { prompt }, false)
  }

  // "New chat": start a fresh active chat, leaving prior chats resumable.
  async resetSession(worktree: Worktree, name: string): Promise<ChatMeta> {
    await this.stop(worktree.id, name)
    // The conversation context changes — queued messages must not auto-submit
    // into a chat they weren't written for.
    this.clearQueue(worktree.id, name, false)
    const chat = this.createChat(worktree.id, name)
    // Reuse the onSession event as the persistence trigger.
    this.events.onSession?.(worktree.id, name, '')
    return chat
  }

  // Read a chat's on-disk transcript (newest-capped) for replay/switching.
  async readTranscript(worktreePath: string, name: string, chatId: string): Promise<string[]> {
    const logPath = this.transcriptPath(worktreePath, name, chatId)
    try {
      const text = await readFile(logPath, 'utf8')
      const lines = text.split('\n').filter((line) => line.length > 0)
      return lines.slice(-MAX_TRANSCRIPT_LINES)
    } catch {
      return []
    }
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

  private requestDialog(
    worktreeId: string,
    name: string,
    request: Omit<AgentDialogRequest, 'id'>
  ): Promise<AgentDialogDecision> {
    const id = `${this.key(worktreeId, name)}::dlg${++this.dialogSeq}`
    const entry = this.running.get(this.key(worktreeId, name))
    entry?.pendingDialogs.add(id)
    this.events.onDialog?.({ id, ...request })
    return new Promise((resolve) => {
      this.dialogResolvers.set(id, resolve)
    })
  }

  respondDialog(id: string, decision: AgentDialogDecision): void {
    const resolve = this.dialogResolvers.get(id)
    if (!resolve) return
    this.dialogResolvers.delete(id)
    for (const entry of this.running.values()) entry.pendingDialogs.delete(id)
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
    this.settleQueue(worktreeId, name, status, entry.clearQueueOnStop)
  }

  // What happens to queued messages when a run reaches a terminal state:
  // clean exit auto-submits them as the next turn; a user stop hands their
  // text back to the composer; an error keeps them visible for manual retry.
  private settleQueue(
    worktreeId: string,
    name: string,
    status: AgentStatus,
    clearQueueOnStop: boolean
  ): void {
    const key = this.key(worktreeId, name)
    const queue = this.queues.get(key) ?? []
    if (queue.length === 0) return

    if (status === 'stopped') {
      if (clearQueueOnStop) this.clearQueue(worktreeId, name, true)
      return
    }
    if (status !== 'exited') return

    const launch = this.lastLaunch.get(key)
    if (!launch) return
    this.queues.set(key, [])
    this.emitQueue(worktreeId, name)
    const prompt = queue.map((item) => item.text).join('\n\n')
    void this.start(launch.worktree, name, launch.agent, launch.ports, {
      ...launch.options,
      prompt
    }).catch(() => {})
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
    for (const id of entry.pendingDialogs) {
      const resolve = this.dialogResolvers.get(id)
      if (resolve) {
        this.dialogResolvers.delete(id)
        resolve({ behavior: 'cancelled' })
      }
    }
    entry.pendingDialogs.clear()
  }

  async stop(
    worktreeId: string,
    name: string,
    opts?: { clearQueue?: boolean }
  ): Promise<void> {
    const entry = this.running.get(this.key(worktreeId, name))
    if (!entry) {
      // Nothing running, but a user stop still flushes any waiting messages.
      if (opts?.clearQueue) this.clearQueue(worktreeId, name, true)
      return
    }
    if (opts?.clearQueue) entry.clearQueueOnStop = true
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
