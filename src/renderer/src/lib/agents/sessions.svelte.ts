// Agent sessions, from the renderer's point of view.
//
// The main process owns the sessions; this owns which of them belongs to which
// worktree and which one is on screen. The listing is fetched whole and split
// here by `workspaceRoot` — the worktree path, because that is what grove passes
// as the workspace when it creates a session.
//
// Two mechanisms: a session you have opened keeps its subscription even while you
// look at another, so switching back is instant and a pending approval elsewhere
// is already on screen. The rest are covered by polling the listing, which
// reports status and pending approvals without a stream.

import {
  createSession,
  deleteSession,
  getSession,
  listEvents,
  listSessions,
  sendEvents,
  updateSession
} from './api'
import { openStream } from './stream'
import { autoDecisionFor, type AgentMode } from './modes'
import { settings } from '../settings.svelte'
import { applyEvent, createTranscript, pendingApprovals, type TranscriptState } from './transcript'
import type {
  ClientEventBody,
  CreateSessionOptions,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  SessionUpdate
} from './types'

// Each open session keeps its transcript folded in memory for as long as it is
// open. A handful is enough to make switching back instant without holding every
// conversation grove has ever had.
const MAX_STREAMS = 4

const POLL_INTERVAL_MS = 3_000

// Inline edits have their own conversation and model so changing their model
// never mutates the interactive Agent pane session. The stable title lets a
// renderer reload rediscover the task session from the persisted listing.
const INLINE_SESSION_TITLE = 'Inline edits'

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

class AgentSessions {
  // Every session the server knows about, newest first.
  list = $state<SessionMeta[]>([])
  live = $state<Record<string, LiveSession>>({})
  // Which session is on screen, per worktree path, so switching worktrees and
  // back lands where you left off.
  activeByWorktree = $state<Record<string, string>>({})
  // The permission mode chosen for a session, keyed by session id. Held here
  // rather than in the pane because it decides how approvals are answered, and
  // an approval has to be answered whoever started the run — an inline edit
  // dispatched from the editor is not going to answer its own prompts.
  modes = $state<Record<string, AgentMode>>({})
  // Set when the server itself is unreachable, as opposed to one session failing.
  serverError = $state('')

  private closers = new Map<string, () => void>()
  // Most recently viewed last, which is the order streams are evicted in.
  private recency: string[] = []
  private viewing: string | null = null
  private poller: ReturnType<typeof setInterval> | null = null
  private watchers = 0
  private inlineByWorktree = new Map<string, string>()
  private inlineEnsures = new Map<string, Promise<string | null>>()

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

  modeFor(sessionId: string): AgentMode {
    return this.modes[sessionId] ?? 'default'
  }

  setMode(sessionId: string, mode: AgentMode): void {
    this.modes = { ...this.modes, [sessionId]: mode }
  }

  setActive(worktreePath: string, sessionId: string | null): void {
    const next = { ...this.activeByWorktree }
    if (sessionId === null) delete next[worktreePath]
    else next[worktreePath] = sessionId
    this.activeByWorktree = next
  }

  async refreshList(): Promise<void> {
    try {
      this.list = await listSessions()
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

  /**
   * The interactive session to talk to for a worktree, creating one if it has
   * none. Used by places such as keybind actions that send to "the agent"
   * without the user explicitly picking a session.
   */
  async ensureFor(worktreePath: string): Promise<string | null> {
    const existing = this.resolveActive(worktreePath)
    if (existing) return existing
    await this.refreshList()
    const afterRefresh = this.resolveActive(worktreePath)
    if (afterRefresh) return afterRefresh
    return this.create(worktreePath)
  }

  /**
   * Reuse the worktree's dedicated inline-edit session, creating it in the
   * background when needed. It is deliberately not made active: the Agent pane
   * keeps its own conversation and model while inline edits retain context with
   * one another. The selected model is reasserted before each dispatch, so a
   * user inspecting and changing this session cannot make the two tasks drift.
   */
  async ensureInlineFor(
    worktreePath: string,
    selected?: { provider: string; model: string }
  ): Promise<string | null> {
    const pending = this.inlineEnsures.get(worktreePath)
    if (pending) return pending
    const ensure = this.ensureInlineSession(worktreePath, selected).finally(() => {
      this.inlineEnsures.delete(worktreePath)
    })
    this.inlineEnsures.set(worktreePath, ensure)
    return ensure
  }

  /** Say something to a worktree's agent, starting a session if there is none. */
  async sendText(worktreePath: string, text: string): Promise<string | null> {
    const sessionId = await this.ensureFor(worktreePath)
    if (!sessionId) return null
    await this.send(sessionId, [
      { type: 'user.message', content: [{ type: 'text', text }], deliverAs: 'steer' }
    ])
    return sessionId
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

  private async ensureInlineSession(
    worktreePath: string,
    selected?: { provider: string; model: string }
  ): Promise<string | null> {
    await this.refreshList()
    const remembered = this.inlineByWorktree.get(worktreePath)
    let session = this.list.find(
      (candidate) =>
        candidate.workspaceRoot === worktreePath &&
        (candidate.id === remembered || candidate.title === INLINE_SESSION_TITLE)
    )

    try {
      if (!session) {
        const created = await createSession({
          workspace: worktreePath,
          title: INLINE_SESSION_TITLE,
          provider: selected?.provider,
          model: selected?.model
        })
        this.inlineByWorktree.set(worktreePath, created.id)
        this.serverError = ''
        await this.refreshList()
        return created.id
      }

      this.inlineByWorktree.set(worktreePath, session.id)
      if (
        selected &&
        (session.provider !== selected.provider || session.model !== selected.model)
      ) {
        const result = await updateSession(session.id, selected)
        const live = this.live[session.id]
        if (live) live.snapshot = result.session
        session = { ...session, provider: selected.provider, model: selected.model }
        await this.refreshList()
      }
      this.serverError = ''
      return session.id
    } catch (cause) {
      this.serverError = messageOf(cause)
      return null
    }
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

  /**
   * Send client events to a session.
   *
   * Events are snapshotted first: anything assembled out of `$state` (composer
   * attachments, an editor selection) arrives as a Svelte proxy, and Electron's
   * IPC cannot clone one — it fails the whole send with "An object could not be
   * cloned".
   */
  async send(sessionId: string, events: ClientEventBody[]): Promise<void> {
    const session = this.live[sessionId]
    try {
      await sendEvents(sessionId, $state.snapshot(events) as ClientEventBody[])
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
      for (const event of await listEvents(session.id)) applyEvent(session.transcript, event)
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
      if (event.type === 'agent.tool_use') this.applyMode(session.id, event)
      // Usage and the queue only live in the snapshot, so a turn boundary is
      // worth a re-read.
      if (event.type === 'session.status_idle') void this.refreshSnapshot(session.id)
    })
    this.closers.set(session.id, close)
  }

  /** Answer an approval the session's mode says not to bother the user with. */
  private applyMode(sessionId: string, event: SessionEvent): void {
    if (event.type !== 'agent.tool_use' || event.permission !== 'ask') return
    const reviewMode = settings.get<string>('workbench.reviewMode') ?? 'pre'
    const result = autoDecisionFor(this.modeFor(sessionId), event.name, reviewMode)
    if (!result) return
    void this.send(sessionId, [
      { type: 'user.tool_confirmation', toolUseId: event.toolUseId, result }
    ])
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
  return String(cause)
}

export const agentSessions = new AgentSessions()
