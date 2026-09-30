// Pure helpers for building the @file:lines reference used by inline edit.
// Kept free of renderer/store imports so they are unit-testable in isolation.

import type { AgentMode } from './agents/modes'

// How an inline edit is reviewed:
//  - auto:   agent applies the edit, no review at all.
//  - inline: agent applies the edit, changes surface as an in-buffer per-hunk
//            accept/reject overlay.
//  - gated:  the edit is gated by the permission dialog before anything writes.
export type ReviewMode = 'auto' | 'inline' | 'gated'

export const REVIEW_MODES: ReviewMode[] = ['auto', 'inline', 'gated']

// Translate a review mode into the agent permission mode that implements it.
// `gated` wants every write put to the user before it lands; `auto` and `inline`
// both want edits applied without asking, and differ only in whether the overlay
// is then shown.
export function pickAgentMode(review: ReviewMode): AgentMode {
  if (review === 'gated') return 'default'
  return 'acceptEdits'
}

// Absolute buffer path → worktree-relative, matching the @mention format the
// composer already understands. Off-worktree paths pass through unchanged.
export function relFromRoot(root: string | undefined, absPath: string): string {
  if (root && absPath.startsWith(`${root}/`)) return absPath.slice(root.length + 1)
  return absPath
}

// A worktree-relative @-reference for a line range, collapsing single lines to
// a bare `path:line`.
export function selectionRef(relPath: string, startLine: number, endLine: number): string {
  if (startLine === endLine) return `${relPath}:${startLine}`
  return `${relPath}:${startLine}-${endLine}`
}

/**
 * Whether a pane should draw an in-buffer review: it has to be the pane the
 * review was started in and be showing the reviewed file right now. A pane that
 * has moved on to another file keeps the review, but not its controls.
 */
export function reviewShownIn(
  review: { leafId: string; absPath: string },
  leafId: string,
  bufferPath: string | null
): boolean {
  if (review.leafId !== leafId) return false
  return bufferPath === review.absPath
}

/**
 * Whether a review of a file's uncommitted changes has nothing left to review:
 * its file is no longer among the worktree's changes, because they were
 * committed or discarded. Its hunks were diffed against the HEAD of the moment
 * it opened, so left up it would offer to "reject" what is now committed.
 *
 * Only a working-tree review settles this way; an inline edit is diffed against
 * its own snapshot, not against git.
 */
export function workingTreeReviewSettled(
  review: { origin: 'inlineEdit' | 'workingTree'; worktreeId: string; relPath: string },
  worktreeId: string,
  changedPaths: string[]
): boolean {
  if (review.origin !== 'workingTree') return false
  if (review.worktreeId !== worktreeId) return false
  return !changedPaths.includes(review.relPath)
}
