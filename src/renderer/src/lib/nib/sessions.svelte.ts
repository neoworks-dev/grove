// Agent sessions, from grove's point of view.
//
// nib owns the sessions; grove owns which of them belongs to which worktree and
// which one is on screen. nib has no server-side workspace filter, so the listing
// is fetched whole and split here by `workspaceRoot` — which is the worktree path,
// because that is what grove passes as the workspace when it creates a session.
//
// Two mechanisms, following nib's own client: a session you have opened keeps its
// EventSource even while you look at another, so switching back is instant and a
// pending approval elsewhere is already on screen. The rest are covered by polling
// the listing, which reports status and pending approvals without a stream.

import {
  createSession,
  deleteSession,
  getSession,
  listEvents,
  listSessions,
  sendEvents,
  updateSession,
  type ApiError
} from './api'
import { openStream } from './stream'
import { applyEvent, createTranscript, pendingApprovals, type TranscriptState } from './transcript'
import type {
  ClientEventBody,
  CreateSessionOptions,
  SessionMeta,
  SessionSnapshot,
  SessionUpdate
} from './types'

// Chromium caps concurrent connections per origin, and each open session holds
// one for as long as it is open. Well under the limit leaves room for ordinary
// requests.
const MAX_STREAMS = 4

const POLL_INTERVAL_MS = 3_000

export interface LiveSession {
  id: string
  snapshot: SessionSnapshot | null
  transcript: TranscriptState
  // Events seen since you last had this session open.
  unread: number
  error: string
  loading: boolean
}

export type SessionBadge = 'running' | 'requires_action' | 'error' | 'idle'

class NibSessions {
  // Every session the server knows about, newest first.
  list = $state<SessionMeta[]>([])
  live = $state<Record<string, LiveSession>>({})
  // Which session is on screen, per worktree path, so switching worktrees and
  // back lands where you left off.
  activeByWorktree = $state<Record<string, string>>({})
  // Set when the server itself is unreachable, as opposed to one session failing.
  serverError = $state('')

  private closers = new Map<string, () => void>()
  // Most recently viewed last, which is the order streams are evicted in.
  private recency: string[] = []
  private viewing: string | null = null
  private poller: ReturnType<typeof setInterval> | null = null
  private watchers = 0

  // ── Listing ─────────────────────────────────────────────────────

  /** Sessions belonging to one worktree, newest first. */
  forWorktree(worktreePath: string): SessionMeta[] {
    return this.list.filter((session) => session.workspaceRoot === worktreePath)
  }

  activeId(worktreePath: string): string | null {
    return this.activeByWorktree[worktreePath] ?? null
  }

  /** The session to show for a worktree: the remembered one, else its newest. */
  resolveActive(worktreePath: string): string | null {
    const remembered = this.activeId(worktreePath)
    const sessions = this.forWorktree(worktreePath)
    if (remembered && sessions.some((session) => session.id === remembered)) return remembered
    return sessions[0]?.id ?? null
  }

  setActive(worktreePath: string, sessionId: string | null): void {
    const next = { ...this.activeByWorktree }
    if (sessionId === null) delete next[worktreePath]
    else next[worktreePath] = sessionId
    this.activeByWorktree = next
  }

  async refreshList(): Promise<void> {
    try {
      const response = await listSessions()
      this.list = response.sessions
      this.serverError = ''
    } catch (cause) {
      this.serverError = messageOf(cause)
    }
  }

  /**
   * Keep the listing fresh while at least one pane is showing it. Reference
   * counted: several agent panes can be open, and the last one to leave stops
   * the timer.
   */
  watch(): () => void {
    this.watchers += 1
    if (this.watchers === 1) {
      void this.refreshList()
      this.poller = setInterval(() => void this.refreshList(), POLL_INTERVAL_MS)
    }
    return () => this.unwatch()
  }

  private unwatch(): void {
    this.watchers = Math.max(0, this.watchers - 1)
    if (this.watchers > 0 || this.poller === null) return
    clearInterval(this.poller)
    this.poller = null
  }

  // ── Session lifecycle ───────────────────────────────────────────

  /** Create a session rooted at a worktree and make it the active one there. */
  async create(worktreePath: string, options: CreateSessionOptions = {}): Promise<string | null> {
    try {
      const snapshot = await createSession({ ...options, workspace: worktreePath })
      this.serverError = ''
      await this.refreshList()
      this.setActive(worktreePath, snapshot.id)
      return snapshot.id
    } catch (cause) {
      this.serverError = messageOf(cause)
      return null
    }
  }

  async remove(worktreePath: string, sessionId: string): Promise<void> {
    this.close(sessionId)
    try {
      await deleteSession(sessionId)
    } catch (cause) {
      this.serverError = messageOf(cause)
    }
    if (this.activeId(worktreePath) === sessionId) this.setActive(worktreePath, null)
    await this.refreshList()
  }

  /** Change title, model, thinking level or the active tool set. */
  async update(sessionId: string, changes: SessionUpdate): Promise<void> {
    const session = this.live[sessionId]
    try {
      const result = await updateSession(sessionId, changes)
      if (session) session.snapshot = result.session
      await this.refreshList()
    } catch (cause) {
      if (session) session.error = messageOf(cause)
      else this.serverError = messageOf(cause)
    }
  }

  // ── Streaming ───────────────────────────────────────────────────

  /**
   * Start streaming a session, or return the one already streaming.
   *
   * History is loaded first and the stream attaches at the cursor it ended on, so
   * the fold sees every event exactly once even if the turn moved on while the
   * request was in flight.
   */
  async open(sessionId: string): Promise<LiveSession> {
    this.touch(sessionId)
    const existing = this.live[sessionId]
    if (existing !== undefined) return existing

    this.evictBeyondLimit()
    this.live[sessionId] = {
      id: sessionId,
      snapshot: null,
      transcript: createTranscript(),
      unread: 0,
      error: '',
      loading: true
    }
    // Read it back: `live` is deeply reactive, so mutations go through its proxy.
    const session = this.live[sessionId]
    await this.loadHistory(session)
    this.attach(session)
    return session
  }

  /** Mark a session as the one on screen, which is what clears its unread count. */
  view(sessionId: string | null): void {
    this.viewing = sessionId
    if (sessionId === null) return
    this.touch(sessionId)
    const session = this.live[sessionId]
    if (session) session.unread = 0
  }

  close(sessionId: string): void {
    this.closers.get(sessionId)?.()
    this.closers.delete(sessionId)
    delete this.live[sessionId]

    const index = this.recency.indexOf(sessionId)
    if (index >= 0) this.recency.splice(index, 1)
  }

  closeAll(): void {
    for (const id of [...this.closers.keys()]) this.close(id)
  }

  // ── Sending ─────────────────────────────────────────────────────

  async send(sessionId: string, events: ClientEventBody[]): Promise<void> {
    const session = this.live[sessionId]
    try {
      await sendEvents(sessionId, events)
      if (session) session.error = ''
      // A queued follow-up shows up in the snapshot, never on the stream.
      await this.refreshSnapshot(sessionId)
    } catch (cause) {
      if (session) session.error = messageOf(cause)
      else this.serverError = messageOf(cause)
    }
  }

  /** Re-read the snapshot, for the fields the stream does not carry: usage, cost, queue. */
  async refreshSnapshot(sessionId: string): Promise<void> {
    const session = this.live[sessionId]
    if (!session) return
    try {
      session.snapshot = await getSession(sessionId)
    } catch (cause) {
      session.error = messageOf(cause)
    }
  }

  // ── Internals ───────────────────────────────────────────────────

  private touch(sessionId: string): void {
    const index = this.recency.indexOf(sessionId)
    if (index >= 0) this.recency.splice(index, 1)
    this.recency.push(sessionId)
  }

  /** Drop the oldest streams, never the one being viewed. */
  private evictBeyondLimit(): void {
    for (const id of [...this.recency]) {
      if (this.closers.size < MAX_STREAMS) return
      if (id !== this.viewing && this.closers.has(id)) this.close(id)
    }
  }

  private async loadHistory(session: LiveSession): Promise<void> {
    try {
      session.snapshot = await getSession(session.id)
      const history = await listEvents(session.id)
      for (const event of history.events) applyEvent(session.transcript, event)
    } catch (cause) {
      session.error = messageOf(cause)
    } finally {
      session.loading = false
    }
  }

  private attach(session: LiveSession): void {
    const close = openStream(session.id, session.transcript.lastSeq, (event) => {
      applyEvent(session.transcript, event)
      if (this.viewing !== session.id) session.unread += 1
      // Usage and the queue only live in the snapshot, so a turn boundary is
      // worth a re-read.
      if (event.type === 'session.status_idle') void this.refreshSnapshot(session.id)
    })
    this.closers.set(session.id, close)
  }
}

/**
 * The badge for a session tab.
 *
 * A streamed session is authoritative; for the rest the polled listing is all
 * there is, which is why both are considered rather than just the live one.
 */
export function badgeOf(meta: SessionMeta, session: LiveSession | undefined): SessionBadge {
  if (session !== undefined) return liveBadge(session)
  if (meta.pendingApprovals.length > 0) return 'requires_action'
  if (meta.status === 'running') return 'running'
  if (meta.stopReason === 'error') return 'error'
  return 'idle'
}

function liveBadge(session: LiveSession): SessionBadge {
  if (pendingApprovals(session.transcript).length > 0) return 'requires_action'
  if (session.transcript.status === 'running') return 'running'
  if (session.transcript.stopReason === 'error' || session.error.length > 0) return 'error'
  return 'idle'
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  const status = (cause as ApiError | undefined)?.status
  if (status !== undefined) return `nib returned ${status}`
  return String(cause)
}

export const nibSessions = new NibSessions()
