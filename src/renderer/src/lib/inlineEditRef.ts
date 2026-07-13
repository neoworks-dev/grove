// Pure helpers for building the @file:lines reference used by inline edit.
// Kept free of renderer/store imports so they are unit-testable in isolation.

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
