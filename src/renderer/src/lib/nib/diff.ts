// Vendored from nib (web/src/renderer/lib/diff.ts), reformatted to grove's style.
// Unchanged otherwise — re-vendor by copying the file over and running prettier.
/**
 * Line diff for the `edit` tool.
 *
 * The renderer never sees the file, only each edit's `oldText` and `newText`, so this diffs those
 * two fragments rather than the whole file. That is enough to show what actually changed inside a
 * replacement, instead of the whole block struck out and re-added.
 */

export type DiffKind = 'context' | 'added' | 'removed'

export interface DiffLine {
  kind: DiffKind
  text: string
}

export interface DiffStats {
  added: number
  removed: number
}

export function diffLines(before: string, after: string): DiffLine[] {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  const table = longestCommonSubsequence(oldLines, newLines)

  return walk(oldLines, newLines, table)
}

export function statsOf(lines: DiffLine[]): DiffStats {
  return {
    added: lines.filter((line) => line.kind === 'added').length,
    removed: lines.filter((line) => line.kind === 'removed').length
  }
}

/** `table[i][j]` is the LCS length of `left[i..]` and `right[j..]`. */
function longestCommonSubsequence(left: string[], right: string[]): number[][] {
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0)
  )

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  return table
}

function walk(left: string[], right: string[], table: number[][]): DiffLine[] {
  const lines: DiffLine[] = []
  let i = 0
  let j = 0

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ kind: 'context', text: left[i]! })
      i += 1
      j += 1
      continue
    }
    // Prefer whichever side keeps more of the common subsequence ahead of it.
    if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: left[i]! })
      i += 1
    } else {
      lines.push({ kind: 'added', text: right[j]! })
      j += 1
    }
  }

  for (; i < left.length; i += 1) {
    lines.push({ kind: 'removed', text: left[i]! })
  }
  for (; j < right.length; j += 1) {
    lines.push({ kind: 'added', text: right[j]! })
  }
  return lines
}
