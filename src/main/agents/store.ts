// Session persistence: the metadata grove lists and the event log it replays.
//
// One directory per session under the store root, holding `meta.json` and an
// append-only `events.jsonl`. The log is the source of truth for a transcript —
// the renderer folds it, the review bridge watches it, and a grove restart
// replays it rather than asking a harness what happened.
//
// The store knows nothing about harnesses. It stamps sequence numbers, writes,
// and tells subscribers. Everything that decides anything lives in the service.

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_ID_LABEL, newAgentId } from './identity'
import { pendingHeldMessages } from './heldMessages'
import { firstPromptText, isDefaultTitle, lastMessagePreview, titleFromPrompt } from './sessionSummary'
import type {
  EventBody,
  SessionEvent,
  SessionMeta,
  SessionPreview,
  SessionSnapshot,
  AgentMode,
  ThinkingLevel,
  Usage
} from '../../shared/agents'

/** The stored half of a session: everything that survives a restart. */
export interface StoredSession {
  id: string
  title: string
  workspaceRoot: string
  harness: string
  provider: string
  model: string
  thinkingLevel: ThinkingLevel
  fastMode: boolean
  activeTools: string[] | null
  autoApproveTools: string[]
  permissionMode: AgentMode
  groveMode: boolean
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
  /** The harness-native conversation id, so a run can be resumed. */
  resumeKey: string | null
  usage: Usage
  cost: number
  /** Tokens the conversation occupied when the harness last said. */
  contextUsed?: number
  contextWindow: number
  lastSeq: number
  /**
   * The harness cleared its conversation (`/clear`) and no message has reached the
   * new one yet. It holds nothing, so the session is as open as a new one: another
   * harness or grove mode can take it over. Absent on sessions never cleared.
   */
  cleared?: boolean
  /**
   * The conversation was taken back to an earlier message (`user.branch`): the
   * next run continues `resumeKey` only up to this agent message, as its ACP
   * `messageId`, and stores the copy it opens as the new `resumeKey`. Kept until
   * that run has started, so a restart in between still rewinds.
   */
  forkAt?: string
}

export interface CreateRecordOptions {
  workspaceRoot: string
  harness: string
  title: string
  provider: string
  model: string
  thinkingLevel: ThinkingLevel
  fastMode?: boolean
  activeTools: string[] | null
  permissionMode?: AgentMode
  groveMode?: boolean
  /** Marks the session is created with, such as the agent that spawned it. */
  labels?: Record<string, string>
}

const META_FILE = 'meta.json'
const EVENTS_FILE = 'events.jsonl'

/**
 * Whether a harness has already taken a turn on a session.
 *
 * A resume key is the harness's own conversation id, which only exists once it
 * has answered; tokens are the same evidence for a harness that resumes without
 * one. Either way the transcript now belongs to that runtime — unless it was
 * cleared since, and the conversation it would resume is empty.
 */
export function hasStarted(session: StoredSession): boolean {
  if (session.cleared === true) return false
  if (session.resumeKey !== null) return true
  return session.usage.inputTokens + session.usage.outputTokens > 0
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/**
 * Sessions on disk, loaded once and kept in memory.
 *
 * Writes are fire-and-forget appends: an event is visible to subscribers the
 * moment it is stamped, and the disk catches up. A write that fails is reported
 * through `onError` rather than breaking the run it belongs to.
 */
export class SessionStore {
  private sessions = new Map<string, StoredSession>()
  private events = new Map<string, SessionEvent[]>()
  private listeners = new Set<(event: SessionEvent) => void>()
  private loaded: Promise<void> | null = null
  private writes = Promise.resolve()

  constructor(
    private root: string,
    private onError: (message: string) => void = () => {}
  ) {}

  /** Read every stored session once. Idempotent; concurrent callers share it. */
  load(): Promise<void> {
    if (!this.loaded) this.loaded = this.readAll()
    return this.loaded
  }

  async list(): Promise<StoredSession[]> {
    await this.load()
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async get(sessionId: string): Promise<StoredSession | undefined> {
    await this.load()
    return this.sessions.get(sessionId)
  }

  /**
   * The session as already loaded, without waiting. For decisions that cannot
   * afford a turn of the event loop — a tool call has to be claimed before the
   * harness reports it on its own stream.
   */
  peek(sessionId: string): StoredSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** The session, or an error naming the id that was asked for. */
  async require(sessionId: string): Promise<StoredSession> {
    const session = await this.get(sessionId)
    if (!session) throw new Error(`unknown agent session: ${sessionId}`)
    return session
  }

  async create(options: CreateRecordOptions): Promise<StoredSession> {
    await this.load()
    const now = new Date().toISOString()
    const session: StoredSession = {
      id: randomUUID(),
      title: options.title,
      workspaceRoot: options.workspaceRoot,
      harness: options.harness,
      provider: options.provider,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      fastMode: options.fastMode === true,
      activeTools: options.activeTools,
      autoApproveTools: [],
      permissionMode: options.permissionMode ?? 'default',
      groveMode: options.groveMode === true,
      // Every session is addressable from the moment it exists, whoever made it.
      labels: { [AGENT_ID_LABEL]: newAgentId(), ...options.labels },
      createdAt: now,
      updatedAt: now,
      resumeKey: null,
      usage: emptyUsage(),
      cost: 0,
      contextWindow: 0,
      lastSeq: 0
    }
    this.sessions.set(session.id, session)
    this.events.set(session.id, [])
    await mkdir(this.dirOf(session.id), { recursive: true })
    await this.writeMeta(session)
    return session
  }

  /** Patch stored fields and persist. Unknown keys are ignored by the caller's types. */
  async patch(sessionId: string, changes: Partial<StoredSession>): Promise<StoredSession> {
    const session = await this.require(sessionId)
    Object.assign(session, changes, { updatedAt: new Date().toISOString() })
    this.queueWrite(() => this.writeMeta(session))
    return session
  }

  async remove(sessionId: string): Promise<void> {
    await this.load()
    this.sessions.delete(sessionId)
    this.events.delete(sessionId)
    await rm(this.dirOf(sessionId), { recursive: true, force: true }).catch(() => {})
  }

  // ── Events ──────────────────────────────────────────────────────

  /** Stamp a body onto the session's log and tell every subscriber. */
  async append(sessionId: string, body: EventBody): Promise<SessionEvent> {
    const session = await this.require(sessionId)
    session.lastSeq += 1
    session.updatedAt = new Date().toISOString()

    const event: SessionEvent = {
      ...body,
      id: randomUUID(),
      seq: session.lastSeq,
      sessionId,
      createdAt: session.updatedAt
    } as SessionEvent

    const log = this.events.get(sessionId)
    if (log) log.push(event)

    this.queueWrite(async () => {
      await appendFile(join(this.dirOf(sessionId), EVENTS_FILE), `${JSON.stringify(event)}\n`)
      await this.writeMeta(session)
    })

    for (const listener of this.listeners) listener(event)
    return event
  }

  async eventsSince(sessionId: string, after = 0): Promise<SessionEvent[]> {
    await this.require(sessionId)
    const log = this.events.get(sessionId) ?? []
    return log.filter((event) => event.seq > after)
  }

  /** Subscribe to every session's events; returns the unsubscribe. */
  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The last message in a session, read off the log already in memory. */
  previewOf(sessionId: string): SessionPreview | null {
    return lastMessagePreview(this.events.get(sessionId) ?? [])
  }

  /** The ids of held agent messages the user has not decided on, read off the log in memory. */
  heldMessagesOf(sessionId: string): string[] {
    return pendingHeldMessages(this.events.get(sessionId) ?? []).map((held) => held.heldId)
  }

  /** The session's events as already loaded, without waiting; empty for an unknown id. */
  peekEvents(sessionId: string): readonly SessionEvent[] {
    return this.events.get(sessionId) ?? []
  }

  dirOf(sessionId: string): string {
    return join(this.root, sessionId)
  }

  // ── Projections ─────────────────────────────────────────────────

  /** The listing row for a stored session. */
  static metaOf(
    session: StoredSession,
    live: boolean,
    runtime: RuntimeState,
    preview: SessionPreview | null,
    heldMessages: string[]
  ): SessionMeta {
    return {
      id: session.id,
      title: session.title,
      workspaceRoot: session.workspaceRoot,
      harness: session.harness,
      provider: session.provider,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      fastMode: session.fastMode,
      activeTools: session.activeTools,
      autoApproveTools: session.autoApproveTools,
      permissionMode: session.permissionMode,
      groveMode: session.groveMode,
      labels: session.labels,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: runtime.status,
      stopReason: runtime.stopReason,
      pendingApprovals: runtime.pendingApprovals,
      heldMessages,
      lastSeq: session.lastSeq,
      live,
      started: hasStarted(session),
      preview
    }
  }

  /** The full snapshot, which adds what only a live run knows. */
  static snapshotOf(
    session: StoredSession,
    live: boolean,
    runtime: RuntimeState,
    messageCount: number,
    preview: SessionPreview | null,
    heldMessages: string[]
  ): SessionSnapshot {
    let used = 0
    if (session.contextUsed !== undefined) used = session.contextUsed
    const window = session.contextWindow
    return {
      ...SessionStore.metaOf(session, live, runtime, preview, heldMessages),
      messageCount,
      usage: session.usage,
      cost: session.cost,
      context: {
        usedTokens: used,
        contextWindow: window,
        remainingTokens: Math.max(0, window - used),
        ratio: window > 0 ? Math.min(1, used / window) : 0
      },
      queued: runtime.queued
    }
  }

  // ── Disk ────────────────────────────────────────────────────────

  private async readAll(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await this.readOne(entry.name)
    }
  }

  private async readOne(sessionId: string): Promise<void> {
    const metaPath = join(this.dirOf(sessionId), META_FILE)
    try {
      const session = parseSession(await readFile(metaPath, 'utf8'))
      const events = await this.readEvents(session.id)
      this.sessions.set(session.id, session)
      this.events.set(session.id, events)
      this.nameUnnamed(session, events)
    } catch (cause) {
      this.onError(`could not read agent session ${sessionId}: ${(cause as Error).message}`)
    }
  }

  private async readEvents(sessionId: string): Promise<SessionEvent[]> {
    const text = await readFile(join(this.dirOf(sessionId), EVENTS_FILE), 'utf8').catch(() => '')
    const events: SessionEvent[] = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        events.push(parseEvent(line))
      } catch {
        // A half-written trailing line from a hard kill; the rest is still good.
      }
    }
    return events
  }

  /**
   * Give a session from before sessions were named after their first prompt
   * that name now, once, so the listing never shows a column of "Session N".
   */
  private nameUnnamed(session: StoredSession, events: readonly SessionEvent[]): void {
    if (!isDefaultTitle(session.title)) return
    const prompt = firstPromptText(events)
    if (!prompt) return
    const title = titleFromPrompt(prompt)
    if (!title) return
    session.title = title
    this.queueWrite(() => this.writeMeta(session))
  }

  private async writeMeta(session: StoredSession): Promise<void> {
    await writeFile(join(this.dirOf(session.id), META_FILE), JSON.stringify(session, null, 2))
  }

  /** Serialize disk writes so appends keep their order without blocking callers. */
  private queueWrite(write: () => Promise<void>): void {
    this.writes = this.writes
      .then(write)
      .catch((cause: Error) => this.onError(`agent session write failed: ${cause.message}`))
  }

  /** Wait for every queued write, for shutdown and for tests. */
  flush(): Promise<void> {
    return this.writes
  }
}

/** The half of a session that only exists while grove is running. */
export interface RuntimeState {
  status: SessionSnapshot['status']
  stopReason?: SessionSnapshot['stopReason']
  pendingApprovals: string[]
  queued: SessionSnapshot['queued']
}

export function idleRuntime(): RuntimeState {
  return { status: 'idle', pendingApprovals: [], queued: [] }
}

/**
 * Read back what this store itself wrote. Nothing else writes these files, so the
 * shape is trusted; a corrupt one throws and is reported by the caller.
 */
function parseJson<T>(text: string): T {
  return JSON.parse(text)
}

/**
 * A stored session, with the fields added after it was written filled in.
 *
 * Sessions are long-lived on disk, so a record from before `permissionMode`
 * existed has to read back as the mode it was actually running under, which is
 * the asking one, and one from before `groveMode` as running without it.
 */
export function parseSession(text: string): StoredSession {
  const session = parseJson<StoredSession>(text)
  const parsed = {
    ...session,
    permissionMode: session.permissionMode ?? 'default',
    groveMode: session.groveMode === true,
    fastMode: session.fastMode === true
  }
  if (parsed.harness === GROVE_HARNESS) return fromGroveHarness(parsed)
  return parsed
}

// The harness grove mode was before it became a switch on every harness.
const GROVE_HARNESS = 'grove'
const GROVE_RUNTIMES = ['claude', 'codex', 'pi']

/**
 * A session stored while grove mode was a harness of its own, moved onto the
 * harness it was actually running on. That harness was named as the provider;
 * the provider becomes the one the harness itself offers the model under.
 */
function fromGroveHarness(session: StoredSession): StoredSession {
  let harness = 'claude'
  if (GROVE_RUNTIMES.includes(session.provider)) harness = session.provider
  return { ...session, harness, provider: providerOn(harness, session.model), groveMode: true }
}

/** The provider a harness offers a model under: Anthropic on Claude, else the model's own prefix. */
function providerOn(harness: string, model: string): string {
  if (harness === 'claude') return 'anthropic'
  const slash = model.indexOf('/')
  if (slash > 0) return model.slice(0, slash)
  return harness
}

function parseEvent(line: string): SessionEvent {
  return parseJson<SessionEvent>(line)
}
