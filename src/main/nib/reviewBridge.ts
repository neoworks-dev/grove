// Grove's review flow, driven from nib's event stream.
//
// The bridge watches every session rooted in a worktree grove knows about and
// turns the four events that matter into calls on the existing ReviewService:
//
//   session.status_running   a turn started      → open a staging batch
//   agent.tool_use (ask)     a write is pending  → raise it as a gated review
//   agent.tool_use (ask)     request_review      → close the batch and raise it
//   session.status_idle      the turn ended      → close whatever is still staged
//
// It runs in the main process rather than the renderer on purpose. A review
// writes files and blocks the agent, and both have to keep working whether or not
// the agent pane is open — the renderer drops streams it is not looking at.

import { relative } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { HunkDecision, ReviewBatch, Worktree } from '../../shared/types'
import type { ReviewService } from '../review'
import { describeResolution } from '../review'
import * as inlineDiff from '../inlineDiff'
import * as files from '../files'
import { readSse } from './sse'
import { nibJson, nibPost, nibRequest, type NibEndpoint } from './transport'

// The agent name grove records reviews under. nib is the only agent now, so the
// review vocabulary treats it as a constant.
export const NIB_AGENT = 'nib'

// nib's file-writing tools. Gating anything else would hold the agent at a
// prompt with no diff to show for it.
const WRITE_TOOLS = new Set(['write', 'edit'])

const REVIEW_TOOL = 'request_review'

const RECONNECT_DELAY_MS = 1_000

// Sessions are created by the renderer and worktrees come and go, so the set to
// watch is discovered rather than announced.
const SYNC_INTERVAL_MS = 3_000

interface SessionMetaRow {
  id: string
  workspaceRoot: string
}

interface ToolUseEvent {
  toolUseId: string
  name: string
  input: Record<string, unknown>
  permission: 'allow' | 'ask'
}

export interface ReviewBridgeOptions {
  review: ReviewService
  endpoint: () => NibEndpoint | null
  // Worktrees grove currently has open; sessions rooted anywhere else are not
  // grove's business.
  worktrees: () => Worktree[]
  reviewMode: () => string
}

export class NibReviewBridge {
  // Sessions being watched, and the worktree each one belongs to.
  private watched = new Map<string, { worktreePath: string; stop: () => void }>()
  // Gated reviews awaiting a verdict, keyed by batch id, so resolving one knows
  // which tool call to answer.
  private gated = new Map<string, { sessionId: string; toolUseId: string }>()
  private syncTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private options: ReviewBridgeOptions) {}

  /** Begin discovering sessions. Idempotent, so a restart can just call it again. */
  start(): void {
    this.stopped = false
    void this.sync()
    if (this.syncTimer) return
    this.syncTimer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS)
  }

  /**
   * Pick up any session rooted in a known worktree and watch it. Called after the
   * server comes up and whenever the worktree list changes; watching an already
   * watched session is a no-op.
   */
  async sync(): Promise<void> {
    const endpoint = this.options.endpoint()
    if (!endpoint || this.stopped) return

    const roots = new Set(this.options.worktrees().map((worktree) => worktree.path))
    let sessions: SessionMetaRow[]
    try {
      const response = await nibJson<{ sessions: SessionMetaRow[] }>(endpoint, {
        method: 'GET',
        path: '/v1/sessions'
      })
      sessions = response.sessions
    } catch {
      // The server is not answering; the next sync will try again.
      return
    }

    for (const session of sessions) {
      if (!roots.has(session.workspaceRoot)) continue
      if (this.watched.has(session.id)) continue
      this.watch(session.id, session.workspaceRoot)
    }
  }

  /** Drop every stream. The server restarting invalidates all of them. */
  reset(): void {
    for (const entry of this.watched.values()) entry.stop()
    this.watched.clear()
  }

  stop(): void {
    this.stopped = true
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    this.reset()
  }

  // ── Resolving ───────────────────────────────────────────────────

  /**
   * Report a finished review to the agent.
   *
   * A gated write is answered as the tool call it is: allowed when everything was
   * accepted, denied with the reasons when it was not — grove has already written
   * the accepted hunks itself, so letting the tool run would undo them.
   *
   * Everything else is told in a message rather than a tool result. `steer` is
   * drained at the top of every turn, so the verdict lands immediately without
   * being dressed up as an error.
   */
  async report(batch: ReviewBatch, decisions: HunkDecision[]): Promise<void> {
    const endpoint = this.options.endpoint()
    if (!endpoint) return

    const feedback = describeResolution(batch, { batchId: batch.id, decisions })
    const gated = this.gated.get(batch.id)
    this.gated.delete(batch.id)

    if (gated) {
      const rejected = decisions.some((decision) => !decision.accepted)
      await this.confirm(gated.sessionId, gated.toolUseId, rejected ? 'deny' : 'allow', feedback)
      return
    }
    if (feedback) await this.sendMessage(batch.chatId, feedback)
  }

  /** A gated review the user bypassed by answering its approval directly. */
  discard(batchId: string): void {
    this.gated.delete(batchId)
  }

  /** Deliver model-visible review feedback without attributing it to the user. */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const endpoint = this.options.endpoint()
    if (!endpoint) return
    await nibPost(endpoint, `/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: 'app.message',
          label: 'Review feedback',
          text,
          deliverAs: 'steer'
        }
      ]
    }).catch(() => {})
  }

  private async confirm(
    sessionId: string,
    toolUseId: string,
    result: 'allow' | 'deny',
    reason: string | null
  ): Promise<void> {
    const endpoint = this.options.endpoint()
    if (!endpoint) return
    await nibPost(endpoint, `/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: 'user.tool_confirmation',
          toolUseId,
          result,
          reason: reason ?? undefined
        }
      ]
    }).catch(() => {})
  }

  // ── Watching ────────────────────────────────────────────────────

  private watch(sessionId: string, worktreePath: string): void {
    let closed = false
    const stop = (): void => {
      closed = true
    }
    this.watched.set(sessionId, { worktreePath, stop })
    void this.consume(sessionId, worktreePath, () => closed)
  }

  /**
   * Follow one session's stream, reconnecting from the last sequence seen. nib
   * replays exactly the gap, so a dropped connection costs nothing.
   */
  private async consume(
    sessionId: string,
    worktreePath: string,
    isClosed: () => boolean
  ): Promise<void> {
    let cursor = 0

    while (!isClosed() && !this.stopped) {
      const endpoint = this.options.endpoint()
      if (!endpoint) return

      let response: IncomingMessage
      try {
        response = await nibRequest(endpoint, {
          method: 'GET',
          path: `/v1/sessions/${sessionId}/stream?after=${cursor}`,
          headers: { accept: 'text/event-stream' }
        })
      } catch {
        await sleep(RECONNECT_DELAY_MS)
        continue
      }

      try {
        for await (const frame of readSse(response)) {
          if (isClosed()) break
          if (frame.id) cursor = Number(frame.id) || cursor
          await this.handle(sessionId, worktreePath, frame.event, frame.data)
        }
      } catch {
        // A stream that breaks mid-turn is reconnected below, from `cursor`.
      }
      if (isClosed() || this.stopped) return
      await sleep(RECONNECT_DELAY_MS)
    }
  }

  private async handle(
    sessionId: string,
    worktreePath: string,
    type: string,
    data: string
  ): Promise<void> {
    if (type === 'session.status_running') {
      this.options.review.openBatch(worktreePath, NIB_AGENT, sessionId)
      return
    }
    if (type === 'session.status_idle') {
      await this.options.review.closeTurn(worktreePath, NIB_AGENT, sessionId)
      return
    }
    if (type !== 'agent.tool_use') return

    const event = parseToolUse(data)
    if (!event || event.permission !== 'ask') return

    if (event.name === REVIEW_TOOL) {
      await this.handleReviewRequest(sessionId, worktreePath, event)
      return
    }
    if (WRITE_TOOLS.has(event.name)) await this.raiseGated(sessionId, worktreePath, event)
  }

  /**
   * The agent called request_review. nib is holding its loop on the confirmation,
   * so answering it is what releases the agent — which is exactly the blocking
   * request_review the review service already expects.
   */
  private async handleReviewRequest(
    sessionId: string,
    worktreePath: string,
    event: ToolUseEvent
  ): Promise<void> {
    const summary = typeof event.input.summary === 'string' ? event.input.summary : ''
    const outcome = await this.options.review.requestReview(
      worktreePath,
      NIB_AGENT,
      sessionId,
      summary
    )
    // requestReview only returns once the user has decided (or immediately, when
    // the run is not configured to pause). Either way the call itself is allowed;
    // what the user said travels as the tool's result.
    await this.confirm(sessionId, event.toolUseId, 'allow', null)
    if (outcome) await this.sendMessage(sessionId, outcome)
  }

  /**
   * A pending write, raised as a diff before it reaches disk. The file is still
   * untouched, so the "current" side is what the agent proposes to write.
   */
  private async raiseGated(
    sessionId: string,
    worktreePath: string,
    event: ToolUseEvent
  ): Promise<void> {
    if (this.options.reviewMode() === 'post') return
    const path = typeof event.input.path === 'string' ? event.input.path : ''
    if (!path) return

    const absolute = path.startsWith('/') ? path : `${worktreePath}/${path}`
    const original = await files.readFileContent(worktreePath, absolute).catch(() => '') // a file the agent is creating
    const proposed = proposedContent(event.name, event.input, original)
    if (proposed === null || proposed === original) return

    const hunks = await inlineDiff.hunksBetween(worktreePath, original, proposed)
    if (hunks.length === 0) return

    const batchId = await this.options.review.raiseGated(
      worktreePath,
      NIB_AGENT,
      sessionId,
      event.toolUseId,
      event.name,
      { relPath: relative(worktreePath, absolute), baseline: original, current: proposed, hunks }
    )
    if (batchId) this.gated.set(batchId, { sessionId, toolUseId: event.toolUseId })
  }
}

/**
 * What one of nib's write tools would leave on disk.
 *
 * `write` replaces the file; `edit` applies exact-match replacements in order,
 * each against the text the previous one produced.
 */
export function proposedContent(
  toolName: string,
  input: Record<string, unknown>,
  original: string
): string | null {
  if (toolName === 'write') {
    return typeof input.content === 'string' ? input.content : null
  }
  if (toolName !== 'edit' || !Array.isArray(input.edits)) return null

  let text = original
  for (const entry of input.edits as Record<string, unknown>[]) {
    if (typeof entry.oldText !== 'string' || typeof entry.newText !== 'string') continue
    if (entry.oldText.length === 0) continue
    text = text.replace(entry.oldText, entry.newText)
  }
  return text
}

function parseToolUse(data: string): ToolUseEvent | null {
  try {
    const event = JSON.parse(data) as Partial<ToolUseEvent>
    if (typeof event.toolUseId !== 'string' || typeof event.name !== 'string') return null
    return {
      toolUseId: event.toolUseId,
      name: event.name,
      input: (event.input as Record<string, unknown>) ?? {},
      permission: event.permission === 'ask' ? 'ask' : 'allow'
    }
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
