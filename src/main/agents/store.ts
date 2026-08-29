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
import type {
  EventBody,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
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
  activeTools: string[] | null
  autoApproveTools: string[]
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
  /** The harness-native conversation id, so a run can be resumed. */
  resumeKey: string | null
  usage: Usage
  cost: number
  contextWindow: number
  lastSeq: number
}

export interface CreateRecordOptions {
  workspaceRoot: string
  harness: string
  title: string
  provider: string
  model: string
  thinkingLevel: ThinkingLevel
  activeTools: string[] | null
}

const META_FILE = 'meta.json'
const EVENTS_FILE = 'events.jsonl'

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
      activeTools: options.activeTools,
      autoApproveTools: [],
      labels: {},
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

  dirOf(sessionId: string): string {
    return join(this.root, sessionId)
  }

  // ── Projections ─────────────────────────────────────────────────

  /** The listing row for a stored session. */
  static metaOf(session: StoredSession, live: boolean, runtime: RuntimeState): SessionMeta {
    return {
      id: session.id,
      title: session.title,
      workspaceRoot: session.workspaceRoot,
      harness: session.harness,
      provider: session.provider,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      activeTools: session.activeTools,
      autoApproveTools: session.autoApproveTools,
      labels: session.labels,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: runtime.status,
      stopReason: runtime.stopReason,
      pendingApprovals: runtime.pendingApprovals,
      lastSeq: session.lastSeq,
      live
    }
  }

  /** The full snapshot, which adds what only a live run knows. */
  static snapshotOf(
    session: StoredSession,
    live: boolean,
    runtime: RuntimeState,
    messageCount: number
  ): SessionSnapshot {
    const used = session.usage.inputTokens + session.usage.outputTokens
    const window = session.contextWindow
    return {
      ...SessionStore.metaOf(session, live, runtime),
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
      this.sessions.set(session.id, session)
      this.events.set(session.id, await this.readEvents(session.id))
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

function parseSession(text: string): StoredSession {
  return parseJson<StoredSession>(text)
}

function parseEvent(line: string): SessionEvent {
  return parseJson<SessionEvent>(line)
}
