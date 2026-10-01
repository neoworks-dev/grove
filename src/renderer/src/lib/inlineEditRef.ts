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

// The fields of a stored session that decide whether inline edits can run in it.
export interface InlineSessionCandidate {
  id: string
  title: string
  workspaceRoot: string
  harness: string
  started: boolean
}

/**
 * Which of a worktree's inline-edit sessions an edit on `harness` runs in, and
 * whether that session's harness has to be switched first. Null means a new one
 * is needed: every existing one has started on another harness, which then
 * cannot be changed. An empty `harness` takes whichever session there is.
 */
export function chooseInlineSession<Session extends InlineSessionCandidate>(
  sessions: Session[],
  worktreePath: string,
  harness: string,
  rememberedId: string | undefined,
  inlineTitle: string
): { session: Session; switchHarness: boolean } | null {
  const inline = sessions.filter(
    (session) =>
      session.workspaceRoot === worktreePath &&
      (session.id === rememberedId || session.title === inlineTitle)
  )
  // The remembered session goes first, so a worktree keeps using the one it had.
  inline.sort((left, right) => Number(right.id === rememberedId) - Number(left.id === rememberedId))

  const sameHarness = inline.find((session) => harness === '' || session.harness === harness)
  if (sameHarness) return { session: sameHarness, switchHarness: false }

  const unstarted = inline.find((session) => !session.started)
  if (unstarted) return { session: unstarted, switchHarness: true }
  return null
}
