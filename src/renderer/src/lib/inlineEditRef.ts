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
