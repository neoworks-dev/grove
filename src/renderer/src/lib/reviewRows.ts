// Turns a review file (its baseline, its current content, and the zero-context
// hunks between them) into rows to render.
//
// The whole file is emitted, not just the changed regions: a hunk can only be
// judged against the code around it. Unchanged lines carry both line numbers;
// changed lines carry the index of the hunk they belong to, so a control can be
// attached to the first row of each hunk and a verdict applied to all of it.

import type { InlineHunk } from '../../../shared/types'

export type DiffRowKind = 'context' | 'removed' | 'added'

export interface DiffRow {
  kind: DiffRowKind
  text: string
  // 1-based line in the baseline; null for an added line.
  beforeLine: number | null
  // 1-based line in the current content; null for a removed line.
  afterLine: number | null
  // Index into the file's hunks, for changed rows only.
  hunkIndex: number | null
  // First row of its hunk — the row a per-hunk control anchors to.
  hunkStart: boolean
}

// One line of a side-by-side view. Either side is null where that side has no
// line (a pure insertion has no left, a pure deletion no right).
export interface DiffRowPair {
  left: DiffRow | null
  right: DiffRow | null
}

// `split('\n')` on text ending in a newline yields a trailing '' that is an
// artifact of the terminator, not a real line. Both sides get the same
// treatment, so dropping it keeps the two in step.
function toLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Build the unified row sequence for a file: every line of it, with changed
 * lines tagged by hunk.
 *
 * Only the baseline is needed — the current content is reconstructed from it
 * plus the hunks, which is also what rebuildWithAccepted does when the verdicts
 * are applied. Deriving both from one source keeps what is shown and what is
 * written from drifting apart.
 */
export function buildDiffRows(baseline: string, hunks: InlineHunk[]): DiffRow[] {
  const beforeLines = toLines(baseline)
  const rows: DiffRow[] = []

  // Hunks are applied in baseline order; the parser does not guarantee it.
  const ordered = hunks
    .map((hunk, index) => ({ hunk, index }))
    .sort((a, b) => a.hunk.beforeStart - b.hunk.beforeStart)

  let before = 1 // next baseline line to emit
  let after = 1 // next current line to emit

  for (const { hunk, index } of ordered) {
    // A replacement starts AT beforeStart; a pure insertion goes AFTER it, so
    // that line is still context.
    const contextEnd = hunk.removed.length > 0 ? hunk.beforeStart : hunk.beforeStart + 1
    while (before < contextEnd && before <= beforeLines.length) {
      rows.push(contextRow(beforeLines[before - 1], before, after))
      before += 1
      after += 1
    }

    let first = true
    for (const text of hunk.removed) {
      rows.push({
        kind: 'removed',
        text,
        beforeLine: before,
        afterLine: null,
        hunkIndex: index,
        hunkStart: first
      })
      before += 1
      first = false
    }
    for (const text of hunk.added) {
      rows.push({
        kind: 'added',
        text,
        beforeLine: null,
        afterLine: after,
        hunkIndex: index,
        hunkStart: first
      })
      after += 1
      first = false
    }
  }

  while (before <= beforeLines.length) {
    rows.push(contextRow(beforeLines[before - 1], before, after))
    before += 1
    after += 1
  }
  return rows
}

function contextRow(text: string, beforeLine: number, afterLine: number): DiffRow {
  return { kind: 'context', text, beforeLine, afterLine, hunkIndex: null, hunkStart: false }
}

/**
 * Pair the unified rows into side-by-side rows: removals on the left, additions
 * on the right, lined up so a replaced line sits opposite its replacement.
 */
export function toSideBySide(rows: DiffRow[]): DiffRowPair[] {
  const pairs: DiffRowPair[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]
    if (row.kind === 'context') {
      pairs.push({ left: row, right: row })
      index += 1
      continue
    }
    // Collect the whole changed block, then zip its removals against its
    // additions so a rewritten line faces the line that replaced it.
    const removed: DiffRow[] = []
    const added: DiffRow[] = []
    while (index < rows.length && rows[index].kind !== 'context') {
      if (rows[index].kind === 'removed') removed.push(rows[index])
      else added.push(rows[index])
      index += 1
    }
    const height = Math.max(removed.length, added.length)
    for (let offset = 0; offset < height; offset++) {
      pairs.push({ left: removed[offset] ?? null, right: added[offset] ?? null })
    }
  }
  return pairs
}

/** Rows of one hunk, for applying a verdict to the whole hunk at once. */
export function hunkRowRange(rows: DiffRow[], hunkIndex: number): DiffRow[] {
  return rows.filter((row) => row.hunkIndex === hunkIndex)
}
