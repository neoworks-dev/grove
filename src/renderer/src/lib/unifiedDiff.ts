// Assemble a single-buffer unified diff view from the two file sides and git's
// hunk ranges. The hunks come from git (`git diff` — never computed here); this
// only interleaves the sides into one line list for the inline diff mode,
// tagging which output lines are removed (from original) or added (from
// modified). Line numbers are 1-based in both the inputs and the output.

import type { DiffHunk } from '../../../shared/types'

export interface UnifiedDiff {
  lines: string[]
  removed: number[] // 1-based output line numbers rendered as deletions
  added: number[] // 1-based output line numbers rendered as additions
}

export function buildUnified(
  original: string[],
  modified: string[],
  hunks: DiffHunk[]
): UnifiedDiff {
  const lines: string[] = []
  const removed: number[] = []
  const added: number[] = []
  let orig = 1 // next 1-based original line to emit as context

  const pushContextTo = (target: number): void => {
    while (orig < target) {
      lines.push(original[orig - 1] ?? '')
      orig += 1
    }
  }

  const ordered = [...hunks].sort((a, b) => a.originalStart - b.originalStart)
  for (const hunk of ordered) {
    if (hunk.originalCount > 0) {
      pushContextTo(hunk.originalStart)
      for (let i = 0; i < hunk.originalCount; i++) {
        lines.push(original[hunk.originalStart - 1 + i] ?? '')
        removed.push(lines.length)
      }
      orig = hunk.originalStart + hunk.originalCount
    } else {
      // Pure insertion: keep context through the anchor line, add nothing to it.
      pushContextTo(hunk.originalStart + 1)
    }
    for (let i = 0; i < hunk.modifiedCount; i++) {
      lines.push(modified[hunk.modifiedStart - 1 + i] ?? '')
      added.push(lines.length)
    }
  }
  pushContextTo(original.length + 1)
  return { lines, removed, added }
}
