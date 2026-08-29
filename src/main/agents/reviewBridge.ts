// grove's review flow, driven from the agent event log.
//
// The bridge watches every session and turns the events that matter into calls
// on the ReviewService:
//
//   session.status_running   a turn started      → open a staging batch
//   agent.tool_use (ask)     a write is pending  → raise it as a gated review
//   agent.tool_use (ask)     request_review      → close the batch and raise it
//   session.status_idle      the turn ended      → close whatever is still staged
//
// It runs beside the store rather than in the renderer on purpose: a review
// writes files and blocks the agent, and both have to keep working whether or
// not the agent pane is open.
//
// Which tool call counts as a write is the harness's business — `intentOf` on
// its descriptor answers that, so a harness with different tool names needs no
// change here.

import { relative } from 'node:path'
import type { HunkDecision, ReviewBatch } from '../../shared/types'
import type { SessionEvent } from '../../shared/agents'
import type { ReviewService } from '../review'
import { describeResolution } from '../review'
import * as inlineDiff from '../inlineDiff'
import * as files from '../files'
import type { HarnessRegistry } from './harness'
import type { AgentService } from './service'
import type { SessionStore } from './store'

export interface ReviewBridgeOptions {
  review: ReviewService
  agents: AgentService
  store: SessionStore
  harnesses: HarnessRegistry
  reviewMode: () => string
}

export class AgentReviewBridge {
  // Gated reviews awaiting a verdict, keyed by batch id, so resolving one knows
  // which tool call to answer.
  private gated = new Map<string, { sessionId: string; toolUseId: string }>()

  constructor(private options: ReviewBridgeOptions) {}

  /** Follow the event log. Returns the inverse, as every effect must. */
  watch(): () => void {
    return this.options.store.subscribe((event) => void this.handle(event))
  }

  // ── Resolving ───────────────────────────────────────────────────

  /**
   * Report a finished review to the agent.
   *
   * A gated write is answered as the tool call it is: allowed when everything
   * was accepted, denied with the reasons when it was not — grove has already
   * written the accepted hunks itself, so letting the tool run would undo them.
   *
   * Everything else is told in a message rather than a tool result. `steer` is
   * drained at the top of every turn, so the verdict lands immediately without
   * being dressed up as an error.
   */
  async report(batch: ReviewBatch, decisions: HunkDecision[]): Promise<void> {
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
    await this.options.agents
      .send(sessionId, [
        { type: 'app.message', label: 'Review feedback', text, deliverAs: 'steer' }
      ])
      .catch(() => {})
  }

  private async confirm(
    sessionId: string,
    toolUseId: string,
    result: 'allow' | 'deny',
    reason: string | null
  ): Promise<void> {
    await this.options.agents
      .send(sessionId, [
        {
          type: 'user.tool_confirmation',
          toolUseId,
          result,
          reason: reason ?? undefined
        }
      ])
      .catch(() => {})
  }

  // ── Watching ────────────────────────────────────────────────────

  private async handle(event: SessionEvent): Promise<void> {
    const session = await this.options.store.get(event.sessionId)
    if (!session) return
    const worktreePath = session.workspaceRoot
    const agent = session.harness

    if (event.type === 'session.status_running') {
      this.options.review.openBatch(worktreePath, agent, event.sessionId)
      return
    }
    if (event.type === 'session.status_idle') {
      await this.options.review.closeTurn(worktreePath, agent, event.sessionId)
      return
    }
    if (event.type !== 'agent.tool_use' || event.permission !== 'ask') return

    const intent = this.intentOf(agent, event.name, event.input)
    if (!intent) return
    if (intent.kind === 'review') {
      await this.handleReviewRequest(event, worktreePath, agent, intent.summary)
      return
    }
    await this.raiseGated(event, worktreePath, agent, intent)
  }

  private intentOf(
    harnessId: string,
    name: string,
    input: unknown
  ): ReturnType<NonNullable<ReturnType<HarnessRegistry['get']>>['intentOf']> {
    const descriptor = this.options.harnesses.get(harnessId)
    if (!descriptor) return null
    return descriptor.intentOf(name, (input as Record<string, unknown>) ?? {})
  }

  /**
   * The agent called its review tool. The harness is holding its loop on the
   * confirmation, so answering it is what releases the agent — which is exactly
   * the blocking request_review the review service already expects.
   */
  private async handleReviewRequest(
    event: Extract<SessionEvent, { type: 'agent.tool_use' }>,
    worktreePath: string,
    agent: string,
    summary: string
  ): Promise<void> {
    const outcome = await this.options.review.requestReview(
      worktreePath,
      agent,
      event.sessionId,
      summary
    )
    // requestReview only returns once the user has decided (or immediately, when
    // the run is not configured to pause). Either way the call itself is
    // allowed; what the user said travels as a message.
    await this.confirm(event.sessionId, event.toolUseId, 'allow', null)
    if (outcome) await this.sendMessage(event.sessionId, outcome)
  }

  /**
   * A pending write, raised as a diff before it reaches disk. The file is still
   * untouched, so the "current" side is what the agent proposes to write.
   */
  private async raiseGated(
    event: Extract<SessionEvent, { type: 'agent.tool_use' }>,
    worktreePath: string,
    agent: string,
    intent: { kind: 'write'; path: string; apply(original: string): string | null }
  ): Promise<void> {
    if (this.options.reviewMode() === 'post') return

    const absolute = intent.path.startsWith('/') ? intent.path : `${worktreePath}/${intent.path}`
    // A file the agent is creating has no original; an empty baseline is right.
    const original = await files.readFileContent(worktreePath, absolute).catch(() => '')
    const proposed = intent.apply(original)
    if (proposed === null || proposed === original) return

    const hunks = await inlineDiff.hunksBetween(worktreePath, original, proposed)
    if (hunks.length === 0) return

    const batchId = await this.options.review.raiseGated(
      worktreePath,
      agent,
      event.sessionId,
      event.toolUseId,
      event.name,
      { relPath: relative(worktreePath, absolute), baseline: original, current: proposed, hunks }
    )
    if (batchId) this.gated.set(batchId, { sessionId: event.sessionId, toolUseId: event.toolUseId })
  }
}
