// grove's review flow, driven from the agent event log.
//
// The bridge watches every session and turns the events that matter into calls
// on the ReviewService:
//
//   session.status_running   a turn started      → open a staging batch
//   permission (a diff)      a write is pending  → raise it as a gated review
//   session.status_idle      the turn ended      → close the batch and raise it
//
// It runs beside the store rather than in the renderer on purpose: a review
// writes files and blocks the agent, and both have to keep working whether or
// not the agent pane is open.
//
// A write is recognised by what the permission request carries, not by the
// tool's name: ACP describes a file change as a diff whichever harness makes
// it, so no harness's tool names are known here.

import { relative } from 'node:path'
import type { HunkDecision, ReviewBatch } from '../../shared/types'
import type { RequestPermissionRequest } from '@neoworks/harness'
import type { SessionEvent } from '../../shared/agents'
import type { ReviewService } from '../review'
import { describeResolution } from '../review'
import * as inlineDiff from '../inlineDiff'
import * as files from '../files'
import { diffsOf, toolNameOf } from './acpLog'
import type { AgentService } from './service'
import type { SessionStore } from './store'

export interface ReviewBridgeOptions {
  review: ReviewService
  agents: AgentService
  store: SessionStore
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
      const summary = this.closingSummary(event.sessionId)
      await this.options.review.closeTurn(worktreePath, agent, event.sessionId, summary)
      return
    }
    if (event.type !== 'permission') return

    const toolCall = event.request.toolCall
    const name = toolNameOf(toolCall)
    const write = writeOf(event.request)
    if (!write) return
    await this.raiseGated(event, worktreePath, agent, toolLabelOf(name, toolCall.title), write)
  }

  /** What the agent ended its turn on, to head the review with; nothing when it said nothing. */
  private closingSummary(sessionId: string): string | undefined {
    const preview = this.options.store.previewOf(sessionId)
    if (!preview || preview.from !== 'agent') return undefined
    return preview.text
  }

  /**
   * A pending write, raised as a diff before it reaches disk. The file is still
   * untouched, so the "current" side is what the agent proposes to write.
   */
  private async raiseGated(
    event: Extract<SessionEvent, { type: 'permission' }>,
    worktreePath: string,
    agent: string,
    toolName: string,
    write: PendingWrite
  ): Promise<void> {
    if (this.options.reviewMode() === 'post') return

    const absolute = write.path.startsWith('/') ? write.path : `${worktreePath}/${write.path}`
    // A file the agent is creating has no original; an empty baseline is right.
    const original = await files.readFileContent(worktreePath, absolute).catch(() => '')
    const proposed = write.apply(original)
    if (proposed === null || proposed === original) return

    const hunks = await inlineDiff.hunksBetween(worktreePath, original, proposed)
    if (hunks.length === 0) return

    const toolUseId = event.request.toolCall.toolCallId
    const batchId = await this.options.review.raiseGated(
      worktreePath,
      agent,
      event.sessionId,
      toolUseId,
      toolName,
      { relPath: relative(worktreePath, absolute), baseline: original, current: proposed, hunks }
    )
    if (batchId) this.gated.set(batchId, { sessionId: event.sessionId, toolUseId })
  }
}

/** A file change a permission request is asking to make. */
interface PendingWrite {
  path: string
  /** What the file would contain afterwards, or null when it cannot be known. */
  apply(original: string): string | null
}

/**
 * The write a permission request asks for, from the diffs it carries. A call
 * that changes several files is left to the plain approval: a gated review
 * answers one call for one file.
 */
export function writeOf(request: RequestPermissionRequest): PendingWrite | null {
  const diffs = diffsOf(request.toolCall.content)
  if (diffs.length === 0) return null
  const path = diffs[0].path
  if (diffs.some((diff) => diff.path !== path)) return null
  return { path, apply: (original) => applyDiffs(original, diffs) }
}

/**
 * The file after a call's diffs. A diff with no old text writes the file whole;
 * one with old text replaces that text, which is how harnesses describe an edit
 * of part of a file. Old text the file no longer contains means the diff cannot
 * be placed, and the answer is unknown rather than a guess.
 */
function applyDiffs(
  original: string,
  diffs: { oldText: string | null; newText: string }[]
): string | null {
  let text = original
  for (const diff of diffs) {
    if (diff.oldText === null) {
      text = diff.newText
      continue
    }
    if (diff.oldText.length === 0 && text.length === 0) {
      text = diff.newText
      continue
    }
    const at = text.indexOf(diff.oldText)
    if (at < 0) return null
    text = text.slice(0, at) + diff.newText + text.slice(at + diff.oldText.length)
  }
  return text
}

/** What to call the tool in the review: its name, else its title. */
function toolLabelOf(name: string | null, title: string | null | undefined): string {
  if (name) return name
  if (title) return title
  return 'edit'
}

