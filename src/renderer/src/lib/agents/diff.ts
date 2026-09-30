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

/** One file a tool call changed, as its harness reported it (ACP `diff` content). */
export interface FileDiff {
  path: string
  /** Null when the call created the file. */
  oldText: string | null
  newText: string
}

/** A run of changed lines with the unchanged lines around them. */
export type DiffHunk = DiffLine[]

// Past this many cells the line table costs more than a preview is worth, and the
// change is shown as the old lines out and the new ones in.
const MAX_TABLE_CELLS = 4_000_000

/** The file diffs among a call's content entries, skipping text and terminals. */
export function fileDiffsOf(content: readonly { type: string }[]): FileDiff[] {
  const diffs: FileDiff[] = []
  for (const entry of content) {
    const diff = fileDiffOf(entry)
    if (diff !== null) {
      diffs.push(diff)
    }
  }
  return diffs
}

/** The entry as a file diff, or null when it is some other kind of content. */
function fileDiffOf(entry: { type: string }): FileDiff | null {
  if (entry.type !== 'diff') {
    return null
  }
  const fields = entry as { path?: unknown; oldText?: unknown; newText?: unknown }
  if (typeof fields.path !== 'string' || typeof fields.newText !== 'string') {
    return null
  }
  let oldText: string | null = null
  if (typeof fields.oldText === 'string') {
    oldText = fields.oldText
  }
  return { path: fields.path, oldText, newText: fields.newText }
}

/**
 * The changed lines of a diff, each with up to `contextLines` unchanged lines
 * around it. Hunks closer than twice that merge; the unchanged stretch between
 * two hunks is dropped.
 *
 * Harnesses report either a fragment (Claude's `Edit`) or the whole file
 * (grove's own `edit` and `write`), so the unchanged head and tail are trimmed
 * before diffing: a one-line change to a long file stays cheap.
 */
export function hunksOf(before: string | null, after: string, contextLines: number): DiffHunk[] {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  const prefix = commonPrefixLength(oldLines, newLines)
  const suffix = commonSuffixLength(oldLines, newLines, prefix)

  const lines: DiffLine[] = []
  for (const text of oldLines.slice(0, prefix)) {
    lines.push({ kind: 'context', text })
  }
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix)
  const newMiddle = newLines.slice(prefix, newLines.length - suffix)
  lines.push(...middleDiff(oldMiddle, newMiddle))
  for (const text of oldLines.slice(oldLines.length - suffix)) {
    lines.push({ kind: 'context', text })
  }
  return groupHunks(lines, contextLines)
}

/** The lines of a text; a final newline ends the last line rather than starting another. */
function splitLines(text: string | null): string[] {
  if (text === null || text.length === 0) {
    return []
  }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

/** How many lines both sides open with. */
function commonPrefixLength(left: string[], right: string[]): number {
  let length = 0
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1
  }
  return length
}

/** How many lines both sides end with, without reaching back into the shared prefix. */
function commonSuffixLength(left: string[], right: string[], prefix: number): number {
  let length = 0
  while (
    length < left.length - prefix &&
    length < right.length - prefix &&
    left[left.length - 1 - length] === right[right.length - 1 - length]
  ) {
    length += 1
  }
  return length
}

/** The diff of the part that changed, or all of it out and in when it is too big to align. */
function middleDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  if ((oldLines.length + 1) * (newLines.length + 1) <= MAX_TABLE_CELLS) {
    const table = longestCommonSubsequence(oldLines, newLines)
    return walk(oldLines, newLines, table)
  }
  const lines: DiffLine[] = []
  for (const text of oldLines) {
    lines.push({ kind: 'removed', text })
  }
  for (const text of newLines) {
    lines.push({ kind: 'added', text })
  }
  return lines
}

/** Splits a full line diff into hunks, keeping `contextLines` of context around each change. */
function groupHunks(lines: DiffLine[], contextLines: number): DiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'context') {
      return
    }
    const from = Math.max(0, index - contextLines)
    const to = Math.min(lines.length - 1, index + contextLines)
    for (let position = from; position <= to; position += 1) {
      keep[position] = true
    }
  })

  const hunks: DiffHunk[] = []
  let current: DiffHunk = []
  lines.forEach((line, index) => {
    if (keep[index]) {
      current.push(line)
      return
    }
    if (current.length > 0) {
      hunks.push(current)
      current = []
    }
  })
  if (current.length > 0) {
    hunks.push(current)
  }
  return hunks
}
