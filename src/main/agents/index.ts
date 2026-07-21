// Agent manager. Owns the adapter registry (claude/codex/opencode), runs one
// agent per (worktree, name), streams normalized output + status to IPC, and
// bridges interactive tool-permission requests between adapters and the user.

import { createWriteStream, type WriteStream } from 'fs'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  AgentChats,
  AgentCommandsEvent,
  AgentConfig,
  AgentDialogDecision,
  AgentDialogRequest,
  AgentLaunchOptions,
  AgentOption,
  AgentQueueEvent,
  AgentRuntime,
  AgentSendResult,
  AgentSlashCommand,
  AgentStatus,
  ChatMeta,
  PermissionDecision,
  PermissionRequestEvent,
  QueuedMessage,
  Worktree,
  WorktreeChatMessage
} from '../../shared/types'
import type { AgentAdapter, RunHandle } from './types'
import { userPromptLine } from './types'
import { FileLockManager } from './locks'
import { WorktreeChannel } from './channel'
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
  onLog: (worktreeId: string, name: string, chatId: string, line: string) => void
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
  // A new message on a worktree's shared chat channel (agent or user origin).
  onChat?: (message: WorktreeChatMessage) => void
  // A checkpoint-worthy moment: the user sent a message / answered a question,
  // or an agent turn ended. Fire-and-forget; the handler snapshots the worktree.
  onCheckpoint?: (
    worktreePath: string,
    trigger: 'agent-turn-end' | 'user-message',
    ctx: { name?: string; chatId?: string }
  ) => void
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
  // Cached model-list probes per adapter, fetched lazily from each adapter's SDK
  // (adapter.listModels) the first time that adapter's list is requested.
  private models = new Map<string, Promise<AgentOption[]>>()
  private lastLaunch = new Map<string, LastLaunch>()
  private runSeq = 0
  // Cross-agent file-edit locks, keyed by the running agent's worktreeId::name.
  private locks = new FileLockManager()
  // Shared per-worktree chat channel (agent↔agent + agent↔user).
  private channel = new WorktreeChannel({ onMessage: (message) => this.onChatMessage(message) })
  // Recent chat-injection timestamps per worktree, to rate-limit agent↔agent
  // chatter so it can't loop into a runaway.
  private chatInjectTimes = new Map<string, number[]>()

  // `adapters` is injectable for tests; production uses the module registry.
  constructor(
    private events: AgentEvents,
    private adapters: Map<string, AgentAdapter> = registry
  ) {}

  // Container key: the AgentChats list + discovered commands for an adapter in a
  // worktree. One container holds every instance (chat) of that adapter.
  private key(worktreeId: string, name: string): string {
    return `${worktreeId}::${name}`
  }

  // Run key: one concurrently-running instance. Multiple instances of the same
  // adapter run at once, each keyed by its chatId.
  private runKey(worktreeId: string, name: string, chatId: string): string {
    return `${worktreeId}::${name}::${chatId}`
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

  // Model list for one adapter, fetched straight from its SDK (adapter.listModels)
  // the first time it's asked for and cached thereafter. Adapters without a
  // model-list API (e.g. codex) return []. Probing is lazy so we don't spin up
  // an unused provider (e.g. the opencode server) until it's actually selected.
  listModels(name: string, cwd: string): Promise<AgentOption[]> {
    const existing = this.models.get(name)
    if (existing) return existing
    const adapter = registry.get(name)
    const probe = adapter?.listModels
      ? adapter.listModels(cwd).catch(() => [])
      : Promise.resolve<AgentOption[]>([])
    this.models.set(name, probe)
    return probe
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
    // Live-update the tab label of a running instance.
    const run = this.running.get(this.runKey(worktreeId, name, chatId))
    if (run) {
      run.runtime.label = chatName
      this.events.onStatus({ ...run.runtime })
    }
  }

  // Delete an instance (chat): stop its run, drop it from the container, clear
  // its per-instance state, and remove its transcript file.
  async deleteChat(worktreeId: string, name: string, chatId: string): Promise<void> {
    await this.stop(worktreeId, name, chatId)
    const containerKey = this.key(worktreeId, name)
    const container = this.chats.get(containerKey)
    if (container) {
      container.chats = container.chats.filter((chat) => chat.id !== chatId)
      if (container.activeId === chatId) container.activeId = container.chats[0]?.id ?? ''
      if (container.chats.length === 0) this.chats.delete(containerKey)
    }
    const runKey = this.runKey(worktreeId, name, chatId)
    this.queues.delete(runKey)
    this.lastLaunch.delete(runKey)
    // worktreeId is the worktree path.
    await unlink(this.transcriptPath(worktreeId, name, chatId)).catch(() => {})
  }

  activateChat(worktreeId: string, name: string, chatId: string): void {
    const entry = this.ensureChats(this.key(worktreeId, name))
    if (!entry.chats.some((chat) => chat.id === chatId)) return
    // Queues are per instance (runKey), so selecting a different instance no
    // longer needs to flush anything.
    entry.activeId = chatId
  }

  private transcriptPath(worktreePath: string, name: string, chatId: string): string {
    const file = chatId === 'legacy' ? `agent-${name}.log` : `agent-${name}__${chatId}.log`
    return join(logsDir(worktreePath), file)
  }

  // Resolve to an explicit instance, or the container's active chat by default.
  private resolveChatId(worktreeId: string, name: string, chatId?: string): string {
    if (chatId) return chatId
    return this.chats.get(this.key(worktreeId, name))?.activeId ?? ''
  }

  getRuntime(worktreeId: string, name: string, chatId?: string): AgentRuntime | null {
    const id = this.resolveChatId(worktreeId, name, chatId)
    return this.running.get(this.runKey(worktreeId, name, id))?.runtime ?? null
  }

  isRunning(worktreeId: string, name: string, chatId?: string): boolean {
    const id = this.resolveChatId(worktreeId, name, chatId)
    return this.running.has(this.runKey(worktreeId, name, id))
  }

  // Create a new instance (chat) of an adapter without stopping any running
  // sibling — the "+" spawn. Returns the new chat so the caller can select it.
  createInstance(worktreeId: string, name: string, label?: string): ChatMeta {
    return this.createChat(worktreeId, name, label)
  }

  // Move a tab (chatId) to a different adapter, keeping its title but starting a
  // fresh session (SDK sessions can't resume across providers). Used when the
  // user picks a different provider for the current chat. Returns null if the
  // chat isn't found or is running under the old adapter.
  convertInstance(
    worktreeId: string,
    fromName: string,
    toName: string,
    chatId: string
  ): ChatMeta | null {
    if (fromName === toName) return null
    if (this.running.has(this.runKey(worktreeId, fromName, chatId))) return null
    const from = this.chats.get(this.key(worktreeId, fromName))
    const chat = from?.chats.find((entry) => entry.id === chatId)
    if (!from || !chat) return null
    from.chats = from.chats.filter((entry) => entry.id !== chatId)
    if (from.activeId === chatId) from.activeId = from.chats[0]?.id ?? ''
    const moved: ChatMeta = { ...chat, session: '', updatedAt: Date.now() }
    const to = this.ensureChats(this.key(worktreeId, toName))
    to.chats.push(moved)
    to.activeId = chatId
    return moved
  }

  // Every spawned instance in a worktree: live runs plus idle chats. Drives the
  // sidebar/overview rows and the Agent pane's instance switcher.
  listInstances(worktreeId: string): AgentRuntime[] {
    const prefix = `${worktreeId}::`
    const result: AgentRuntime[] = []
    const seen = new Set<string>()
    for (const [key, entry] of this.running) {
      if (!key.startsWith(prefix)) continue
      // Prefer the current chat name so a rename is reflected on the tab.
      const container = this.chats.get(this.key(entry.runtime.worktreeId, entry.runtime.name))
      const chat = container?.chats.find((candidate) => candidate.id === entry.runtime.chatId)
      result.push({ ...entry.runtime, label: chat?.name ?? entry.runtime.label })
      seen.add(`${entry.runtime.name}::${entry.runtime.chatId}`)
    }
    for (const [containerKey, container] of this.chats) {
      if (!containerKey.startsWith(prefix)) continue
      const name = containerKey.slice(prefix.length)
      const adapter = this.adapters.get(name)
      if (!adapter) continue
      for (const chat of container.chats) {
        if (seen.has(`${name}::${chat.id}`)) continue
        result.push({
          worktreeId,
          name,
          chatId: chat.id,
          label: chat.name,
          status: 'stopped',
          pid: null,
          command: adapter.config.command,
          exitCode: null,
          logPath: this.transcriptPath(worktreeId, name, chat.id)
        })
      }
    }
    return result
  }

  async start(
    worktree: Worktree,
    name: string,
    agent: AgentConfig,
    ports: number[],
    options: AgentLaunchOptions,
    // Internal turns (e.g. /compact) suppress the prompt echo so the command
    // doesn't show up as a chat message in the transcript.
    echoPrompt = true,
    // The instance to run. Defaults to the container's active chat.
    chatId?: string
  ): Promise<AgentRuntime> {
    const adapter = this.adapters.get(name)
    if (!adapter) throw new Error(`unknown agent: ${name}`)

    const containerKey = this.key(worktree.id, name)
    const chat = chatId
      ? this.ensureChats(containerKey).chats.find((entry) => entry.id === chatId) ||
        this.activeChat(containerKey)
      : this.activeChat(containerKey)
    // Only stop the same instance's prior run; sibling instances keep running.
    await this.stop(worktree.id, name, chat.id)

    const runKey = this.runKey(worktree.id, name, chat.id)
    this.lastLaunch.set(runKey, { worktree, agent, ports, options })
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
      chatId: chat.id,
      label: chat.name,
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
    this.running.set(runKey, entry)

    // Drop callbacks from a replaced run: its async teardown can fire after the
    // successor registered, and must not write into the new run's entry/stream.
    const isCurrentRun = (): boolean => this.running.get(runKey)?.runId === runId

    const emit = (line: string): void => {
      if (!isCurrentRun()) return
      logStream.write(line + '\n')
      this.events.onLog(worktree.id, name, chat.id, line)
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
        this.handleStatus(worktree.id, name, chat.id, status, exitCode ?? null)
      },
      setSession: (token) => this.rememberSession(worktree.id, name, chat.id, token),
      requestPermission: (request) => this.requestPermission(worktree.id, name, chat.id, request),
      requestDialog: (request) => this.requestDialog(worktree.id, name, chat.id, request),
      pluginAi: this.events.pluginAi,
      setCommands: (commands) => {
        this.commands.set(containerKey, commands)
        this.events.onCommands?.({ worktreeId: worktree.id, name, commands })
      },
      tryAcquireLocks: (paths) => this.locks.tryAcquire(runKey, chat.name, paths),
      releaseLocks: () => this.locks.releaseOwner(runKey),
      chat: {
        send: (text, to) => {
          this.channel.post(worktree.id, { kind: 'agent', name, instanceId: chat.id }, text, to)
        },
        history: (since) => this.channel.list(worktree.id, since)
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
    text: string,
    chatId?: string
  ): Promise<AgentSendResult> {
    const containerKey = this.key(worktree.id, name)
    const chat = chatId
      ? this.ensureChats(containerKey).chats.find((entry) => entry.id === chatId) ||
        this.activeChat(containerKey)
      : this.activeChat(containerKey)
    const runKey = this.runKey(worktree.id, name, chat.id)
    const trimmed = text.trim()
    // Snapshot before the agent acts on the new message, so the pre-turn state
    // is revertible.
    this.events.onCheckpoint?.(worktree.path, 'user-message', { name, chatId: chat.id })
    const entry = this.running.get(runKey)
    if (entry) {
      if (entry.handle.send?.(trimmed)) {
        // Echo like start() does so the injection shows as a chat message.
        const line = userPromptLine(trimmed)
        entry.logStream.write(line + '\n')
        this.events.onLog(worktree.id, name, chat.id, line)
        return { delivered: 'injected' }
      }
      const item: QueuedMessage = { id: randomUUID(), text: trimmed, createdAt: Date.now() }
      const queue = this.queues.get(runKey) ?? []
      queue.push(item)
      this.queues.set(runKey, queue)
      this.emitQueue(worktree.id, name, chat.id)
      return { delivered: 'queued', id: item.id }
    }
    const launch = this.lastLaunch.get(runKey)
    await this.start(
      worktree,
      name,
      agent,
      ports,
      { ...(launch?.options ?? {}), prompt: trimmed },
      true,
      chat.id
    )
    return { delivered: 'started' }
  }

  getQueue(worktreeId: string, name: string, chatId?: string): QueuedMessage[] {
    const id = this.resolveChatId(worktreeId, name, chatId)
    return [...(this.queues.get(this.runKey(worktreeId, name, id)) ?? [])]
  }

  cancelQueued(worktreeId: string, name: string, chatId: string, id: string): void {
    const runKey = this.runKey(worktreeId, name, chatId)
    const queue = this.queues.get(runKey)
    if (!queue) return
    const index = queue.findIndex((item) => item.id === id)
    if (index === -1) return
    queue.splice(index, 1)
    this.emitQueue(worktreeId, name, chatId)
  }

  getCommands(worktreeId: string, name: string): AgentSlashCommand[] {
    return [...(this.commands.get(this.key(worktreeId, name)) ?? [])]
  }

  private emitQueue(
    worktreeId: string,
    name: string,
    chatId: string,
    cleared?: QueuedMessage[]
  ): void {
    const queue = [...(this.queues.get(this.runKey(worktreeId, name, chatId)) ?? [])]
    this.events.onQueue?.({ worktreeId, name, chatId, queue, cleared })
  }

  private clearQueue(
    worktreeId: string,
    name: string,
    chatId: string,
    restoreToUser: boolean
  ): void {
    const runKey = this.runKey(worktreeId, name, chatId)
    const queue = this.queues.get(runKey) ?? []
    if (queue.length === 0) return
    this.queues.set(runKey, [])
    this.emitQueue(worktreeId, name, chatId, restoreToUser ? queue : undefined)
  }

  private rememberSession(worktreeId: string, name: string, chatId: string, token: string): void {
    if (!token) return
    const container = this.ensureChats(this.key(worktreeId, name))
    const chat = container.chats.find((entry) => entry.id === chatId)
    if (!chat || chat.session === token) return
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
    instructions?: string,
    chatId?: string
  ): Promise<AgentRuntime> {
    const focus = (instructions || '').trim()
    const prompt = focus ? `/compact ${focus}` : '/compact'
    return this.start(worktree, name, agent, ports, { prompt }, false, chatId)
  }

  // "New chat": start a fresh active chat, leaving prior chats resumable. When
  // chatId is given, only that instance's run is stopped first.
  async resetSession(worktree: Worktree, name: string, chatId?: string): Promise<ChatMeta> {
    if (chatId) {
      await this.stop(worktree.id, name, chatId)
      // The conversation context changes — queued messages must not auto-submit
      // into a chat they weren't written for.
      this.clearQueue(worktree.id, name, chatId, false)
    }
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
    chatId: string,
    request: Omit<PermissionRequestEvent, 'id' | 'chatId'>
  ): Promise<PermissionDecision> {
    const runKey = this.runKey(worktreeId, name, chatId)
    const id = `${runKey}::perm${++this.permissionSeq}`
    const entry = this.running.get(runKey)
    entry?.pendingPermissions.add(id)
    this.events.onPermission({ id, chatId, ...request })
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
    chatId: string,
    request: Omit<AgentDialogRequest, 'id' | 'chatId'>
  ): Promise<AgentDialogDecision> {
    const runKey = this.runKey(worktreeId, name, chatId)
    const id = `${runKey}::dlg${++this.dialogSeq}`
    const entry = this.running.get(runKey)
    entry?.pendingDialogs.add(id)
    this.events.onDialog?.({ id, chatId, ...request })
    return new Promise((resolve) => {
      this.dialogResolvers.set(id, resolve)
    })
  }

  respondDialog(id: string, decision: AgentDialogDecision): void {
    const resolve = this.dialogResolvers.get(id)
    if (!resolve) return
    this.dialogResolvers.delete(id)
    for (const entry of this.running.values()) entry.pendingDialogs.delete(id)
    // Answering a question is a user turn — snapshot before the agent resumes.
    // The dialog id is `${worktreeId}::${name}::${chatId}::dlg<n>`, and
    // worktreeId is the worktree path.
    const [worktreeId, name, chatId] = id.split('::')
    if (worktreeId) this.events.onCheckpoint?.(worktreeId, 'user-message', { name, chatId })
    resolve(decision)
  }

  private handleStatus(
    worktreeId: string,
    name: string,
    chatId: string,
    status: AgentStatus,
    exitCode: number | null
  ): void {
    const runKey = this.runKey(worktreeId, name, chatId)
    const entry = this.running.get(runKey)
    if (!entry) return
    entry.runtime.status = status
    entry.runtime.exitCode = exitCode
    entry.runtime.pid = null

    if (status === 'running') {
      this.events.onStatus({ ...entry.runtime })
      return
    }
    // Terminal: auto-deny any still-pending permission, drop file locks, and
    // clean up.
    this.denyPending(entry)
    this.locks.releaseOwner(runKey)
    entry.logStream.end()
    this.events.onStatus({ ...entry.runtime })
    this.running.delete(runKey)
    // Snapshot the worktree after the agent's turn so its edits are revertible.
    const worktreePath = this.lastLaunch.get(runKey)?.worktree.path ?? worktreeId
    this.events.onCheckpoint?.(worktreePath, 'agent-turn-end', { name, chatId })
    this.settleQueue(worktreeId, name, chatId, status, entry.clearQueueOnStop)
  }

  // What happens to queued messages when a run reaches a terminal state:
  // clean exit auto-submits them as the next turn; a user stop hands their
  // text back to the composer; an error keeps them visible for manual retry.
  private settleQueue(
    worktreeId: string,
    name: string,
    chatId: string,
    status: AgentStatus,
    clearQueueOnStop: boolean
  ): void {
    const runKey = this.runKey(worktreeId, name, chatId)
    const queue = this.queues.get(runKey) ?? []
    if (queue.length === 0) return

    if (status === 'stopped') {
      if (clearQueueOnStop) this.clearQueue(worktreeId, name, chatId, true)
      return
    }
    if (status !== 'exited') return

    const launch = this.lastLaunch.get(runKey)
    if (!launch) return
    this.queues.set(runKey, [])
    this.emitQueue(worktreeId, name, chatId)
    const prompt = queue.map((item) => item.text).join('\n\n')
    void this.start(
      launch.worktree,
      name,
      launch.agent,
      launch.ports,
      { ...launch.options, prompt },
      true,
      chatId
    ).catch(() => {})
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
    chatId: string,
    opts?: { clearQueue?: boolean }
  ): Promise<void> {
    const entry = this.running.get(this.runKey(worktreeId, name, chatId))
    if (!entry) {
      // Nothing running, but a user stop still flushes any waiting messages.
      if (opts?.clearQueue) this.clearQueue(worktreeId, name, chatId, true)
      return
    }
    if (opts?.clearQueue) entry.clearQueueOnStop = true
    this.denyPending(entry)
    await entry.handle.stop().catch(() => {})
  }

  // ── Shared worktree chat ───────────────────────────────────────
  // A user message on the channel (from the composer / chat panel).
  sendChat(worktreeId: string, text: string): WorktreeChatMessage {
    return this.channel.post(worktreeId, { kind: 'user', name: 'you' }, text.trim())
  }

  chatHistory(worktreeId: string, since?: number): WorktreeChatMessage[] {
    return this.channel.list(worktreeId, since)
  }

  // Broadcast every message to the UI, and inject it into other running agents
  // in the worktree so they notice without polling. Rate-limited per worktree.
  private onChatMessage(message: WorktreeChatMessage): void {
    this.events.onChat?.(message)
    const prefix = `${message.worktreeId}::`
    for (const [key, entry] of this.running) {
      if (!key.startsWith(prefix)) continue
      const name = entry.runtime.name
      // Never echo a message back to the exact instance that sent it.
      if (message.from.kind === 'agent' && message.from.instanceId === entry.runtime.chatId)
        continue
      // Respect a targeted message (addressed by adapter name).
      if (message.to && message.to !== name) continue
      if (!this.allowChatInject(message.worktreeId)) continue
      entry.handle.send?.(`[chat from ${message.from.name}]: ${message.text}`)
    }
  }

  // Sliding-window limiter: at most 30 injected chat messages per worktree per
  // minute, so agent↔agent replies can't spiral.
  private allowChatInject(worktreeId: string): boolean {
    const now = Date.now()
    const window = 60_000
    const times = (this.chatInjectTimes.get(worktreeId) ?? []).filter((ts) => now - ts < window)
    if (times.length >= 30) {
      this.chatInjectTimes.set(worktreeId, times)
      return false
    }
    times.push(now)
    this.chatInjectTimes.set(worktreeId, times)
    return true
  }

  activeWorktreeIds(): string[] {
    const ids = new Set<string>()
    for (const key of this.running.keys()) ids.add(key.split('::')[0])
    return [...ids]
  }

  async stopAll(): Promise<void> {
    for (const entry of [...this.running.values()]) {
      const { worktreeId, name, chatId } = entry.runtime
      await this.stop(worktreeId, name, chatId)
    }
  }
}
