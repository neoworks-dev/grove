// Post-approve review staging. The agent writes to disk freely; the worktree
// watcher reports which paths changed, and a checkpoint taken when the batch
// opened supplies each file's pre-batch content. Closing the batch diffs the two
// into per-file hunks the user reviews.
//
// Keying off the watcher means a batch never has to guess what the agent
// touched, but it also means the pre-write content is already gone by the time
// we hear about a write — hence the baseline tree, captured up front.
//
// Pre-approve reviews do not come through here: the SDK gates one tool call at a
// time, so those are built directly from the proposed tool input.

import { readFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ReviewBatch, ReviewFile, ReviewOrigin } from '../../shared/types'
import { hunksBetween } from '../inlineDiff'

// Where a batch's baseline content comes from. Injected so staging can be
// tested without a git repo; in the app this is backed by CheckpointManager.
export interface BaselineSource {
  // Tree hash describing the worktree as the batch opens, or null when one
  // cannot be taken (no git repo yet).
  open: (worktreePath: string) => Promise<string | null>
  // Content of one worktree-relative path in that tree; '' when absent.
  read: (worktreePath: string, tree: string, relPath: string) => Promise<string>
}

interface OpenBatch {
  id: string
  worktreePath: string
  agent: string
  chatId: string
  baselineTree: string | null
  // Worktree-relative paths the agent has written since the batch opened.
  touched: Set<string>
}

export class ReviewStaging {
  // One open batch per worktree — a worktree runs one review at a time.
  private batches = new Map<string, OpenBatch>()

  constructor(private baseline: BaselineSource) {}

  /**
   * Open a review batch for a worktree, capturing the baseline every file in it
   * will be diffed against. Re-opening while a batch is already open is a no-op,
   * so a second agent run does not discard the first one's staged writes.
   */
  async open(worktreePath: string, agent: string, chatId: string): Promise<void> {
    if (this.batches.has(worktreePath)) return
    const baselineTree = await this.baseline.open(worktreePath)
    this.batches.set(worktreePath, {
      id: randomUUID(),
      worktreePath,
      agent,
      chatId,
      baselineTree,
      touched: new Set()
    })
  }

  isOpen(worktreePath: string): boolean {
    return this.batches.has(worktreePath)
  }

  /** Number of distinct files staged so far, for the pending-changes badge. */
  stagedCount(worktreePath: string): number {
    return this.batches.get(worktreePath)?.touched.size ?? 0
  }

  /**
   * Record that a file changed on disk. Called from the watcher for every file
   * event in a worktree with an open batch; paths outside the batch are ignored
   * because the watcher already filters the uninteresting trees.
   */
  noteWrite(worktreePath: string, relPath: string): void {
    const batch = this.batches.get(worktreePath)
    if (!batch || !relPath) return
    batch.touched.add(relPath)
  }

  /**
   * Close the batch and resolve it into a reviewable set of files. Returns null
   * when nothing was staged or every staged file turned out unchanged (an agent
   * that rewrote a file with identical content, or edits that cancelled out).
   */
  async close(
    worktreePath: string,
    origin: ReviewOrigin,
    summary?: string
  ): Promise<ReviewBatch | null> {
    const batch = this.batches.get(worktreePath)
    if (!batch) return null
    this.batches.delete(worktreePath)

    const files = await this.resolveFiles(batch)
    if (files.length === 0) return null
    return {
      id: batch.id,
      worktreeId: worktreePath,
      agent: batch.agent,
      chatId: batch.chatId,
      origin,
      summary,
      files
    }
  }

  /** Drop a batch without raising a review (agent aborted, worktree removed). */
  discard(worktreePath: string): void {
    this.batches.delete(worktreePath)
  }

  private async resolveFiles(batch: OpenBatch): Promise<ReviewFile[]> {
    const files: ReviewFile[] = []
    for (const relPath of batch.touched) {
      const file = await this.resolveFile(batch, relPath)
      if (file) files.push(file)
    }
    files.sort((a, b) => a.relPath.localeCompare(b.relPath))
    return files
  }

  private async resolveFile(batch: OpenBatch, relPath: string): Promise<ReviewFile | null> {
    const baseline = batch.baselineTree
      ? await this.baseline.read(batch.worktreePath, batch.baselineTree, relPath)
      : ''
    const { content: current, deleted } = await readCurrent(batch.worktreePath, relPath)
    if (current === baseline && !deleted) return null
    const hunks = await hunksBetween(batch.worktreePath, baseline, current)
    if (hunks.length === 0) return null
    return { relPath, baseline, current, hunks, deleted }
  }
}

// Current on-disk content. A deleted file reads as empty so the diff shows a
// full removal, but the deletion is flagged so accepting it removes the file
// rather than leaving an empty one behind.
async function readCurrent(
  worktreePath: string,
  relPath: string
): Promise<{ content: string; deleted: boolean }> {
  try {
    return { content: await readFile(join(worktreePath, relPath), 'utf8'), deleted: false }
  } catch {
    return { content: '', deleted: true }
  }
}
