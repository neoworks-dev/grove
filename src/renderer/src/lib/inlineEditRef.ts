// Pure helpers for building the @file:lines reference used by inline edit.
// Kept free of renderer/store imports so they are unit-testable in isolation.

// How an inline edit is reviewed:
//  - auto:   agent applies the edit, no review at all.
//  - inline: agent applies the edit, changes surface as an in-buffer per-hunk
//            accept/reject overlay.
//  - gated:  the edit is gated by the permission dialog before anything writes.
export type ReviewMode = 'auto' | 'inline' | 'gated'

export const REVIEW_MODES: ReviewMode[] = ['auto', 'inline', 'gated']

export interface ModeOption {
  label: string
  value: string
}

// Translate a review mode into the concrete agent permission-mode value.
// `gated` wants a mode that prompts before writing; `auto`/`inline` both want
// edits auto-applied (they differ only in whether the overlay is shown). The
// lookup is heuristic (value then label) so it works across adapters whose mode
// vocabularies differ, falling back to the first declared mode.
export function pickAgentMode(modes: ModeOption[], review: ReviewMode): string | undefined {
  if (modes.length === 0) return undefined
  const byValue = (needle: string): ModeOption | undefined =>
    modes.find((mode) => mode.value.toLowerCase() === needle)
  const byText = (needle: string): ModeOption | undefined =>
    modes.find(
      (mode) => mode.value.toLowerCase().includes(needle) || mode.label.toLowerCase().includes(needle)
    )
  if (review === 'gated') {
    return (byValue('default') || byText('manual') || byText('default') || modes[0]).value
  }
  return (byValue('acceptedits') || byText('accept') || modes[0]).value
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
