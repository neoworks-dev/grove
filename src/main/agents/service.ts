// The agent service: sessions, runs and everything the renderer talks to.
//
// One session is a stored record plus, while grove is running, a harness run and
// the state that only exists in memory — status, the message queue, and the tool
// calls parked waiting for an answer. Adapters report progress by emitting event
// bodies; this stamps them onto the log and keeps the runtime state in step.
//
// Nothing here knows how any particular harness works. Swapping Claude for Codex
// changes which descriptor `start()` is called on and nothing else.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type {
  BlobDescriptor,
  ClientEventBody,
  ConfirmationResult,
  CreateSessionOptions,
  DeliverAs,
  FileMatch,
  HarnessCatalog,
  HarnessInfo,
  QueuedMessage,
  ServerEventBody,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  SessionUpdate,
  ThinkingLevel,
  UserContentBlock
} from '../../shared/agents'
import * as files from '../files'
import type { ApprovalRequest, GroveTool, HarnessRegistry, HarnessRun } from './harness'
import { idleRuntime, SessionStore, type RuntimeState, type StoredSession } from './store'

const BLOBS_DIR = 'blobs'

interface PendingApproval {
  name: string
  resolve: (result: ConfirmationResult) => void
}

/** The in-memory half of a session, dropped when grove exits. */
interface Runtime extends RuntimeState {
  run: HarnessRun | null
  starting: Promise<HarnessRun> | null
  approvals: Map<string, PendingApproval>
  /** Tool calls already announced on the log, so an adapter cannot double-report. */
  announced: Set<string>
  messageCount: number
}

export interface AgentServiceOptions {
  store: SessionStore
  harnesses: HarnessRegistry
  /** grove's own tools, offered to every harness that can host them. */
  tools: () => GroveTool[]
  /** Push an event to the renderer. */
  publish(event: SessionEvent): void
  /** The harness to use when a session does not name one. */
  defaultHarness: () => string | undefined
}

export class AgentService {
  private runtimes = new Map<string, Runtime>()

  constructor(private options: AgentServiceOptions) {}

  private get store(): SessionStore {
    return this.options.store
  }

  // ── Harnesses and catalogs ──────────────────────────────────────

  harnesses(): Promise<HarnessInfo[]> {
    return this.options.harnesses.describe()
  }

  /** Models, commands and skills for one harness, for the composer and pickers. */
  async catalog(harnessId: string): Promise<HarnessCatalog> {
    const descriptor = this.options.harnesses.require(harnessId)
    const offering = await descriptor.offering()
    return { harness: harnessId, ...offering }
  }

  // ── Session lifecycle ───────────────────────────────────────────

  async listSessions(): Promise<SessionMeta[]> {
    const stored = await this.store.list()
    return stored.map((session) =>
      SessionStore.metaOf(session, this.isLive(session.id), this.runtimeOf(session.id))
    )
  }

  async createSession(options: CreateSessionOptions): Promise<SessionSnapshot> {
    const harness = this.resolveHarness(options.harness)
    const workspaceRoot = options.workspace
    if (!workspaceRoot) throw new Error('a session needs a workspace')

    const model = await this.startingModel(harness, options)

    const session = await this.store.create({
      workspaceRoot,
      harness,
      title: options.title ?? 'Session',
      provider: model.provider,
      model: model.model,
      thinkingLevel: options.thinkingLevel ?? 'off',
      activeTools: options.activeTools ?? null
    })
    return this.snapshot(session)
  }

  /**
   * The model a new session opens on.
   *
   * A caller that names one gets it. Otherwise the harness is asked what it
   * recommends, so nothing has to be typed in before the first turn — and a
   * harness that cannot say leaves the fields empty, as before.
   */
  private async startingModel(
    harness: string,
    options: CreateSessionOptions
  ): Promise<{ provider: string; model: string }> {
    if (options.model) {
      return { provider: options.provider ?? '', model: options.model }
    }
    const recommended = await this.recommendedModel(harness)
    if (recommended) return recommended
    return { provider: options.provider ?? '', model: '' }
  }

  /** What a harness would pick for itself, or null when it cannot say. */
  private async recommendedModel(
    harness: string
  ): Promise<{ provider: string; model: string } | null> {
    try {
      const offering = await this.options.harnesses.require(harness).offering()
      return offering.default
    } catch {
      // A harness that fails to answer must not stop a session being created.
      return null
    }
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    return this.snapshot(await this.store.require(sessionId))
  }

  async updateSession(
    sessionId: string,
    changes: SessionUpdate
  ): Promise<{ changed: string[]; session: SessionSnapshot }> {
    const before = await this.store.require(sessionId)
    const changed = Object.keys(changes).filter(
      (key) => (changes as Record<string, unknown>)[key] !== undefined
    )
    if (changes.harness && changes.harness !== before.harness) {
      await this.stopRun(sessionId)
      await this.store.patch(sessionId, { resumeKey: null })
    }

    const session = await this.store.patch(sessionId, changes as Partial<StoredSession>)
    await this.applyLiveChanges(sessionId, changes)
    if (changed.length > 0) {
      await this.store.append(sessionId, { type: 'session.info_changed', changed })
    }
    return { changed, session: this.snapshot(session) }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.stopRun(sessionId)
    this.runtimes.delete(sessionId)
    await this.store.remove(sessionId)
  }

  listEvents(sessionId: string, after = 0): Promise<SessionEvent[]> {
    return this.store.eventsSince(sessionId, after)
  }

  // ── Client events ───────────────────────────────────────────────

  /** Accept a batch of client events, in order. */
  async send(sessionId: string, events: ClientEventBody[]): Promise<{ lastSeq: number }> {
    for (const event of events) await this.accept(sessionId, event)
    const session = await this.store.require(sessionId)
    return { lastSeq: session.lastSeq }
  }

  private async accept(sessionId: string, event: ClientEventBody): Promise<void> {
    if (event.type === 'user.tool_confirmation') {
      await this.store.append(sessionId, event)
      await this.answerApproval(sessionId, event.toolUseId, event.result)
      return
    }
    if (event.type === 'user.interrupt') {
      await this.store.append(sessionId, event)
      await this.runtimeOrCreate(sessionId)
        .run?.interrupt()
        .catch(() => {})
      return
    }
    if (event.type === 'user.unqueue') {
      await this.store.append(sessionId, event)
      this.dropQueued(sessionId, event.messageId)
      return
    }
    if (event.type === 'user.message' || event.type === 'app.message') {
      await this.deliver(sessionId, event)
      return
    }
    if (event.type === 'user.command') {
      await this.store.append(sessionId, event)
      await this.runCommand(sessionId, event.name, event.args)
      return
    }
    // Compaction, branching and shell passthrough belong to the harness; the
    // ones that cannot do them say so rather than silently dropping the ask.
    await this.store.append(sessionId, event)
    await this.store.append(sessionId, {
      type: 'session.notice',
      message: `"${event.type}" is not supported by this harness`
    })
  }

  /** Put a message to the agent: straight through, steered, or queued. */
  private async deliver(
    sessionId: string,
    event: Extract<ClientEventBody, { type: 'user.message' | 'app.message' }>
  ): Promise<void> {
    const stamped = await this.store.append(sessionId, event)
    const text = textOf(event)
    const runtime = this.runtimeOrCreate(sessionId)
    runtime.messageCount += 1

    if (runtime.status !== 'running') {
      await this.startTurn(sessionId, text)
      return
    }

    const deliverAs: DeliverAs = event.deliverAs ?? 'followUp'
    const run = runtime.run
    if (deliverAs === 'steer' && run?.steer) {
      await run.steer(text, deliverAs).catch((cause: Error) => this.reportError(sessionId, cause))
      return
    }
    runtime.queued = [...runtime.queued, { id: stamped.id, text, deliverAs }]
  }

  /** Take a message back out of the queue before it is delivered. */
  private dropQueued(sessionId: string, messageId: string): void {
    const runtime = this.runtimeOrCreate(sessionId)
    runtime.queued = runtime.queued.filter((message) => message.id !== messageId)
  }

  /**
   * Run a slash command on the harness.
   *
   * Support is a property of the run rather than the descriptor, so the run has
   * to exist before the ask can be answered either way.
   */
  private async runCommand(sessionId: string, name: string, args: string): Promise<void> {
    try {
      const run = await this.ensureRun(sessionId)
      if (!run.command) {
        await this.store.append(sessionId, {
          type: 'session.notice',
          message: `"/${name}" is not supported by this harness`
        })
        return
      }
      await run.command(name, args)
    } catch (cause) {
      await this.reportError(sessionId, cause as Error)
    }
  }

  private async startTurn(sessionId: string, text: string): Promise<void> {
    try {
      const run = await this.ensureRun(sessionId)
      await run.prompt(text)
    } catch (cause) {
      await this.reportError(sessionId, cause as Error)
    }
  }

  // ── Approvals ───────────────────────────────────────────────────

  /**
   * Park a tool call and announce it as a pending approval.
   *
   * The answer arrives as a `user.tool_confirmation` client event — from the
   * user, from the session's permission mode, or from the review flow once the
   * diff has been decided.
   */
  private requestApproval(
    sessionId: string,
    request: ApprovalRequest
  ): Promise<{ result: ConfirmationResult }> {
    const runtime = this.runtimeOrCreate(sessionId)
    // Claimed before anything is awaited: the adapter reports the same call on
    // its own stream a moment later, and whichever arrives second must not
    // duplicate it — or, worse, report it as ungated.
    const fresh = !runtime.announced.has(request.toolUseId)
    runtime.announced.add(request.toolUseId)

    if (this.autoApproves(sessionId, request.name)) {
      if (fresh) void this.recordToolUse(sessionId, request, 'allow')
      return Promise.resolve({ result: 'allow' as ConfirmationResult })
    }

    runtime.pendingApprovals = [...runtime.pendingApprovals, request.toolUseId]
    // Recorded even when the adapter got there first with an ungated call: the
    // harness reports the call as it is made and only then asks whether it may
    // run it, so the second record is what says the call is parked. The fold
    // updates the call it already has rather than adding another.
    void this.recordToolUse(sessionId, request, 'ask')

    return new Promise((resolve) => {
      runtime.approvals.set(request.toolUseId, {
        name: request.name,
        resolve: (result) => resolve({ result })
      })
    })
  }

  /** Has this session already been told to stop asking about this tool? */
  private autoApproves(sessionId: string, toolName: string): boolean {
    return this.store.peek(sessionId)?.autoApproveTools.includes(toolName) === true
  }

  private async answerApproval(
    sessionId: string,
    toolUseId: string,
    result: ConfirmationResult
  ): Promise<void> {
    const runtime = this.runtimeOrCreate(sessionId)
    const pending = runtime.approvals.get(toolUseId)
    if (!pending) return

    runtime.approvals.delete(toolUseId)
    runtime.pendingApprovals = runtime.pendingApprovals.filter((id) => id !== toolUseId)
    if (result === 'always_session' || result === 'always_project') {
      await this.rememberAutoApproval(sessionId, pending.name)
    }
    pending.resolve(result)
  }

  private async rememberAutoApproval(sessionId: string, toolName: string): Promise<void> {
    const session = await this.store.require(sessionId)
    if (session.autoApproveTools.includes(toolName)) return
    await this.store.patch(sessionId, { autoApproveTools: [...session.autoApproveTools, toolName] })
  }

  /** Put a tool call on the log. The caller has already claimed its id. */
  private async recordToolUse(
    sessionId: string,
    request: ApprovalRequest,
    permission: 'allow' | 'ask'
  ): Promise<void> {
    await this.store.append(sessionId, {
      type: 'agent.tool_use',
      toolUseId: request.toolUseId,
      name: request.name,
      input: request.input,
      permission
    })
  }

  // ── Runs ────────────────────────────────────────────────────────

  /** The run for a session, started on first use and reused after that. */
  private async ensureRun(sessionId: string): Promise<HarnessRun> {
    const runtime = this.runtimeOrCreate(sessionId)
    if (runtime.run) return runtime.run
    if (runtime.starting) return runtime.starting

    runtime.starting = this.startRun(sessionId).finally(() => {
      runtime.starting = null
    })
    return runtime.starting
  }

  private async startRun(sessionId: string): Promise<HarnessRun> {
    const session = await this.store.require(sessionId)
    const descriptor = this.options.harnesses.require(session.harness)
    const runtime = this.runtimeOrCreate(sessionId)

    const run = await descriptor.start({
      sessionId,
      workspaceRoot: session.workspaceRoot,
      provider: session.provider || null,
      model: session.model || null,
      thinkingLevel: session.thinkingLevel,
      activeTools: session.activeTools,
      resumeKey: session.resumeKey,
      tools: this.toolsFor(descriptor),
      emit: (body) => void this.absorb(sessionId, body),
      stats: (update) => void this.store.patch(sessionId, update),
      confirm: (request) => this.requestApproval(sessionId, request)
    })

    runtime.run = run
    if (run.resumeKey && run.resumeKey !== session.resumeKey) {
      await this.store.patch(sessionId, { resumeKey: run.resumeKey })
    }
    return run
  }

  /** grove's own tools, for a harness that can host them. */
  private toolsFor(descriptor: { capabilities: { groveTools: boolean } }): GroveTool[] {
    if (!descriptor.capabilities.groveTools) return []
    return this.options.tools()
  }

  /** Fold a harness event into runtime state, then put it on the log. */
  private async absorb(sessionId: string, body: ServerEventBody): Promise<void> {
    const runtime = this.runtimeOrCreate(sessionId)

    if (body.type === 'agent.tool_use') {
      if (runtime.announced.has(body.toolUseId)) return
      runtime.announced.add(body.toolUseId)
    }
    if (body.type === 'session.status_running') {
      runtime.status = 'running'
      runtime.stopReason = undefined
    }
    if (body.type === 'session.status_terminated') {
      runtime.status = 'terminated'
      runtime.run = null
    }

    await this.store.append(sessionId, body)
    if (body.type === 'session.status_idle') await this.finishTurn(sessionId, body.stopReason)
  }

  /** A turn ended: settle the status, then hand over whatever was queued. */
  private async finishTurn(
    sessionId: string,
    stopReason: RuntimeState['stopReason']
  ): Promise<void> {
    const runtime = this.runtimeOrCreate(sessionId)
    runtime.status = 'idle'
    runtime.stopReason = stopReason
    await this.persistResumeKey(sessionId)

    const next = runtime.queued[0]
    if (!next) return
    runtime.queued = runtime.queued.slice(1)
    await this.startTurn(sessionId, next.text)
  }

  /**
   * Keep the stored conversation id in step with the run's.
   *
   * A run does not keep the id it started with: `/clear` drops the conversation
   * and opens a new one. Storing only the id from `startRun` would resume a
   * conversation the harness has already left behind.
   */
  private async persistResumeKey(sessionId: string): Promise<void> {
    const key = this.runtimes.get(sessionId)?.run?.resumeKey
    if (!key) return
    const session = await this.store.require(sessionId)
    if (session.resumeKey === key) return
    await this.store.patch(sessionId, { resumeKey: key })
  }

  private async applyLiveChanges(sessionId: string, changes: SessionUpdate): Promise<void> {
    const run = this.runtimes.get(sessionId)?.run
    if (!run) return
    if (changes.model && run.setModel) {
      await run.setModel(changes.provider ?? null, changes.model).catch(() => {})
    }
    if (changes.thinkingLevel && run.setThinkingLevel) {
      await run.setThinkingLevel(changes.thinkingLevel).catch(() => {})
    }
  }

  private async stopRun(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.run) return
    const run = runtime.run
    runtime.run = null
    runtime.status = 'idle'
    await run.dispose().catch(() => {})
  }

  /** Stop every run. Called on shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((sessionId) => this.stopRun(sessionId)))
  }

  private async reportError(sessionId: string, cause: Error): Promise<void> {
    await this.store.append(sessionId, { type: 'session.error', message: cause.message })
    await this.absorb(sessionId, { type: 'session.status_idle', stopReason: 'error' })
  }

  // ── Attachments and file search ─────────────────────────────────

  /** Store an attachment beside the session and hand back its reference. */
  async putBlob(
    sessionId: string,
    bytes: Uint8Array,
    mediaType: string,
    filename?: string
  ): Promise<BlobDescriptor> {
    await this.store.require(sessionId)
    const directory = join(this.store.dirOf(sessionId), BLOBS_DIR)
    await mkdir(directory, { recursive: true })
    const ref = `${randomUUID()}${extname(filename ?? '')}`
    await writeFile(join(directory, ref), bytes)
    return { ref, mediaType, filename, bytes: bytes.byteLength }
  }

  async readBlob(sessionId: string, ref: string): Promise<Buffer> {
    if (ref.includes('/') || ref.includes('..')) throw new Error(`bad blob reference: ${ref}`)
    return readFile(join(this.store.dirOf(sessionId), BLOBS_DIR, ref))
  }

  /** Fuzzy path search over the session's workspace, for `@` mentions. */
  async searchFiles(sessionId: string, query: string, limit = 20): Promise<FileMatch[]> {
    const session = await this.store.require(sessionId)
    const paths = await files.listAll(session.workspaceRoot)
    const needle = query.toLowerCase()
    const matches: FileMatch[] = []
    for (const path of paths) {
      const score = scorePath(path.toLowerCase(), needle)
      if (score > 0) matches.push({ path, score })
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  // ── Internals ───────────────────────────────────────────────────

  private resolveHarness(requested: string | undefined): string {
    const wanted = requested ?? this.options.defaultHarness()
    if (wanted) return this.options.harnesses.require(wanted).id
    const first = this.options.harnesses.list()[0]
    if (!first) throw new Error('no agent harness is available')
    return first.id
  }

  private runtimeOrCreate(sessionId: string): Runtime {
    const existing = this.runtimes.get(sessionId)
    if (existing) return existing
    const runtime: Runtime = {
      ...idleRuntime(),
      run: null,
      starting: null,
      approvals: new Map(),
      announced: new Set(),
      messageCount: 0
    }
    this.runtimes.set(sessionId, runtime)
    return runtime
  }

  private runtimeOf(sessionId: string): RuntimeState {
    return this.runtimes.get(sessionId) ?? idleRuntime()
  }

  private isLive(sessionId: string): boolean {
    return (
      this.runtimes.get(sessionId)?.run !== undefined && this.runtimes.get(sessionId)?.run !== null
    )
  }

  private snapshot(session: StoredSession): SessionSnapshot {
    const runtime = this.runtimes.get(session.id)
    return SessionStore.snapshotOf(
      session,
      this.isLive(session.id),
      runtime ?? idleRuntime(),
      runtime?.messageCount ?? 0
    )
  }

  /** Start publishing the store's events to the renderer; returns the inverse. */
  watch(): () => void {
    return this.store.subscribe((event) => this.options.publish(event))
  }

  /** Follow one session's events, for callers that only care about that one. */
  observe(sessionId: string, onEvent: (event: SessionEvent) => void): () => void {
    return this.store.subscribe((event) => {
      if (event.sessionId === sessionId) onEvent(event)
    })
  }

  /** Every harness's models at once, for the plugin API's flat listing. */
  async allModels(): Promise<{ provider: string; models: { id: string }[] }[]> {
    const offerings = await Promise.all(
      this.options.harnesses.list().map(async (descriptor) => {
        const offering = await descriptor.offering().catch(() => null)
        if (!offering) return []
        return offering.providers.map((entry) => ({
          provider: `${descriptor.id}/${entry.provider}`,
          models: entry.models.map((model) => ({ id: model.id }))
        }))
      })
    )
    return offerings.flat()
  }

  /** Queued messages for a session, for callers that only need the queue. */
  queueOf(sessionId: string): QueuedMessage[] {
    return this.runtimes.get(sessionId)?.queued ?? []
  }
}

function textOf(event: Extract<ClientEventBody, { type: 'user.message' | 'app.message' }>): string {
  if (event.type === 'app.message') return `[${event.label}]\n${event.text}`
  return event.content
    .map(blockText)
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * One content block as the model reads it. Attached file slices are tagged with
 * where they came from, so the model can cite lines without reading the file.
 */
function blockText(block: UserContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type !== 'file') return ''
  const range = `${block.startLine}-${block.endLine}`
  return `<file path="${block.path}" lines="${range}">\n${block.text}\n</file>`
}

/**
 * Subsequence match with a bonus for contiguity and for hits in the file name,
 * which is what makes `agpane` find `AgentPane.svelte` above `agents/pane.ts`.
 */
function scorePath(path: string, needle: string): number {
  if (needle.length === 0) return 1
  let score = 0
  let cursor = 0
  let previous = -1
  for (const character of needle) {
    const index = path.indexOf(character, cursor)
    if (index < 0) return 0
    score += index === previous + 1 ? 3 : 1
    previous = index
    cursor = index + 1
  }
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name.includes(needle)) score += 10
  return score
}

/** Thinking levels every harness understands, in order. */
export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
