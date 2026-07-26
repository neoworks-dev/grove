// Agent-write review. Owns the staging layer, raises review requests to the
// renderer, holds the agent when a run is configured to pause for review, and
// applies the user's per-hunk decisions back to disk.
//
// Two shapes of review arrive here:
//  - post-approve: writes already on disk, accumulated into a batch by
//    ReviewStaging and closed by request_review or the turn-end backstop.
//  - pre-approve ('gated'): a single Write/Edit held at the permission prompt.
//    Accepting a subset cannot be expressed as "allow", so the tool is denied and
//    the accepted hunks are written here instead.

import { rm } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  HunkDecision,
  ReviewBatch,
  ReviewFile,
  ReviewOrigin,
  ReviewResolution
} from '../shared/types'
import { ReviewStaging, type BaselineSource } from './agents/reviewStaging'
import { applyInlineReview } from './inlineDiff'

export interface ReviewEvents {
  // A batch is ready for the user to review.
  onReview: (batch: ReviewBatch) => void
  // Staged-file count for a worktree changed (drives the pending badge).
  onStaged: (worktreeId: string, count: number) => void
  // Feedback for an agent that is no longer waiting on a tool result. Delivered
  // as a user message, which starts a new turn.
  onFeedback: (worktreeId: string, agent: string, chatId: string, text: string) => void
}

export interface ReviewSettings {
  // Hold the agent at request_review until the user has decided.
  pause: () => boolean
}

interface PendingReview {
  batch: ReviewBatch
  resolve: (resolution: ReviewResolution) => void
}

export class ReviewService {
  private staging: ReviewStaging
  // Reviews raised to the user and not yet resolved, keyed by batch id.
  private pending = new Map<string, PendingReview>()
  // Batch ids whose agent is blocked inside request_review awaiting the verdict.
  private awaited = new Set<string>()

  constructor(
    baseline: BaselineSource,
    private events: ReviewEvents,
    private settings: ReviewSettings
  ) {
    this.staging = new ReviewStaging(baseline)
  }

  // ── Staging ─────────────────────────────────────────────────────

  openBatch(worktreePath: string, agent: string, chatId: string): void {
    void this.staging.open(worktreePath, agent, chatId)
  }

  /** Record an agent write. Called from the worktree watcher. */
  noteWrite(worktreePath: string, relPath: string): void {
    if (!this.staging.isOpen(worktreePath)) return
    this.staging.noteWrite(worktreePath, relPath)
    this.events.onStaged(worktreePath, this.staging.stagedCount(worktreePath))
  }

  discard(worktreePath: string): void {
    this.staging.discard(worktreePath)
    this.events.onStaged(worktreePath, 0)
  }

  // ── Raising reviews ─────────────────────────────────────────────

  /**
   * The agent called request_review. Closes the batch and raises it. Resolves
   * with the text the model reads back: the user's verdict when the run pauses
   * for review, or an acknowledgement when reviews are queued instead.
   */
  async requestReview(
    worktreePath: string,
    agent: string,
    chatId: string,
    summary: string
  ): Promise<string> {
    const batch = await this.closeAndRaise(worktreePath, agent, chatId, 'agent', summary)
    if (!batch) return 'No file changes to review since your last request.'

    if (!this.settings.pause()) {
      return 'Submitted for review. The user will respond in their own time — carry on.'
    }
    this.awaited.add(batch.id)
    const resolution = await this.awaitResolution(batch)
    return describeResolution(batch, resolution) ?? 'All changes accepted with no comments.'
  }

  /** Turn-end backstop: close whatever is still staged and raise it. */
  async closeTurn(worktreePath: string, agent: string, chatId: string): Promise<void> {
    await this.closeAndRaise(worktreePath, agent, chatId, 'turn-end')
  }

  /**
   * A gated Write/Edit held at the permission prompt. The file is untouched on
   * disk; `proposed` is what the agent wants to write.
   */
  async raiseGated(
    worktreePath: string,
    agent: string,
    chatId: string,
    permissionId: string,
    toolName: string,
    file: ReviewFile
  ): Promise<void> {
    const batch: ReviewBatch = {
      id: randomUUID(),
      worktreeId: worktreePath,
      agent,
      chatId,
      origin: 'gated',
      files: [file],
      permissionId,
      toolName
    }
    this.events.onReview(batch)
  }

  private async closeAndRaise(
    worktreePath: string,
    agent: string,
    chatId: string,
    origin: ReviewOrigin,
    summary?: string
  ): Promise<ReviewBatch | null> {
    const batch = await this.staging.close(worktreePath, origin, summary)
    this.events.onStaged(worktreePath, 0)
    // Reopen immediately so writes made while the user reviews land in the next
    // batch instead of being dropped.
    this.staging.open(worktreePath, agent, chatId).catch(() => {})
    if (!batch) return null
    this.events.onReview(batch)
    return batch
  }

  private awaitResolution(batch: ReviewBatch): Promise<ReviewResolution> {
    return new Promise((resolve) => {
      this.pending.set(batch.id, { batch, resolve })
    })
  }

  // ── Resolving ───────────────────────────────────────────────────

  /**
   * Apply the user's decisions: rewrite each file to hold only its accepted
   * hunks, then report back to the agent. Returns the batch so the caller can
   * resolve an attached permission request.
   */
  async resolve(batchId: string, decisions: HunkDecision[]): Promise<ReviewBatch | null> {
    const entry = this.pending.get(batchId)
    if (!entry) return null
    this.pending.delete(batchId)

    await this.applyDecisions(entry.batch, decisions)

    const wasAwaited = this.awaited.delete(batchId)
    entry.resolve({ batchId, decisions })
    // An agent blocked in request_review reads the verdict as that tool's
    // result; anything else has to be told, and only when there is news.
    if (!wasAwaited) {
      const feedback = describeResolution(entry.batch, { batchId, decisions })
      if (feedback) {
        this.events.onFeedback(entry.batch.worktreeId, entry.batch.agent, entry.batch.chatId, feedback)
      }
    }
    return entry.batch
  }

  /** Register a raised batch as pending without an agent waiting on it. */
  track(batch: ReviewBatch): void {
    if (this.pending.has(batch.id)) return
    this.pending.set(batch.id, { batch, resolve: () => {} })
  }

  pendingBatch(batchId: string): ReviewBatch | null {
    return this.pending.get(batchId)?.batch ?? null
  }

  private async applyDecisions(batch: ReviewBatch, decisions: HunkDecision[]): Promise<void> {
    for (const file of batch.files) {
      await this.applyFile(batch, file, decisions)
    }
  }

  private async applyFile(
    batch: ReviewBatch,
    file: ReviewFile,
    decisions: HunkDecision[]
  ): Promise<void> {
    const applied = file.hunks.map((_hunk, index) => isAccepted(decisions, file.relPath, index))
    // Nothing rejected: post-approve files already hold exactly this on disk.
    if (batch.origin !== 'gated' && applied.every(Boolean)) return

    // The agent removed the file and the removal stands — delete it rather than
    // rebuilding it as empty.
    if (file.deleted && applied.every(Boolean)) {
      await rm(join(batch.worktreeId, file.relPath), { force: true })
      return
    }
    await applyInlineReview(batch.worktreeId, file.relPath, file.baseline, file.hunks, applied)
  }
}

// A hunk with no explicit decision counts as accepted: the user finished the
// review without objecting to it.
function isAccepted(decisions: HunkDecision[], relPath: string, hunkIndex: number): boolean {
  const decision = decisions.find(
    (candidate) => candidate.relPath === relPath && candidate.hunkIndex === hunkIndex
  )
  if (!decision) return true
  return decision.accepted
}

/**
 * Render a review outcome for the agent. Returns null when every hunk was
 * accepted without comment — there is nothing the agent needs to know, and
 * saying so would cost it a turn.
 */
export function describeResolution(
  batch: ReviewBatch,
  resolution: ReviewResolution
): string | null {
  const rejected = resolution.decisions.filter((decision) => !decision.accepted)
  const comments = resolution.decisions.filter((decision) => decision.comment)
  if (rejected.length === 0 && comments.length === 0) return null

  const lines = ['The user reviewed your changes.']
  for (const file of batch.files) {
    const forFile = resolution.decisions.filter((decision) => decision.relPath === file.relPath)
    const rejectedHere = forFile.filter((decision) => !decision.accepted)
    if (rejectedHere.length === 0 && !forFile.some((decision) => decision.comment)) continue

    lines.push('')
    lines.push(`${file.relPath}:`)
    if (rejectedHere.length > 0) {
      const numbers = rejectedHere.map((decision) => decision.hunkIndex + 1).join(', ')
      lines.push(`  Reverted hunk(s) ${numbers}. That code is back to how it was before your edit.`)
    }
    for (const decision of forFile) {
      if (!decision.comment) continue
      const verdict = decision.accepted ? 'kept' : 'reverted'
      lines.push(`  Hunk ${decision.hunkIndex + 1} (${verdict}): ${decision.comment}`)
    }
  }
  lines.push('')
  lines.push('Take the reverted hunks and comments into account before continuing.')
  return lines.join('\n')
}
