/**
 * A turn's file-changing calls → the files it changed, once each.
 *
 * Once a turn folds, what it changed is the part a reader still needs on screen: the calls
 * themselves are detail, the files are the outcome. Several edits to one file are one change
 * from that reader's side, so they merge into a single entry with their line counts summed.
 *
 * Nothing here knows any tool. A call that carries ACP `diff` content says which files it
 * changed and how; one that does not falls back to the file the caller reads off its header
 * and the replacements in its input.
 */

import { diffLines, fileDiffsOf, hunksOf, statsOf, type DiffStats } from './diff'
import { editsOf } from './tools'
import type { ToolItem } from './transcript'

export interface ChangedFile {
  path: string
  added: number
  removed: number
  /** The turn's first change to the file created it. */
  created: boolean
}

/**
 * The files the calls changed, in the order each was first changed. Calls that failed or were
 * refused changed nothing and are skipped.
 */
export function changedFilesOf(
  calls: ToolItem[],
  fileOf: (call: ToolItem) => string | null
): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const call of calls) {
    if (call.status !== 'ok') {
      continue
    }
    for (const change of changesOf(call, fileOf)) {
      addChange(files, change)
    }
  }
  return files
}

/** What one call changed, a file per entry. */
function changesOf(call: ToolItem, fileOf: (call: ToolItem) => string | null): ChangedFile[] {
  const diffs = fileDiffsOf(call.content)
  if (diffs.length > 0) {
    return diffs.map((diff) => {
      const stats = statsOf(hunksOf(diff.oldText, diff.newText, 0).flat())
      return { path: diff.path, ...stats, created: diff.oldText === null }
    })
  }
  const path = fileOf(call)
  if (path === null) {
    return []
  }
  return [{ path, ...replacementStats(call), created: false }]
}

/** Line counts of the replacements a call's input asked for. */
function replacementStats(call: ToolItem): DiffStats {
  let input = call.input
  if (call.editedInput !== null && call.editedInput !== undefined) {
    input = call.editedInput
  }
  const total: DiffStats = { added: 0, removed: 0 }
  for (const edit of editsOf(input)) {
    const stats = statsOf(diffLines(edit.oldText, edit.newText))
    total.added += stats.added
    total.removed += stats.removed
  }
  return total
}

/** Merges a change into the entry for its file, or starts one. */
function addChange(files: ChangedFile[], change: ChangedFile): void {
  const existing = files.find((file) => file.path === change.path)
  if (!existing) {
    files.push(change)
    return
  }
  existing.added += change.added
  existing.removed += change.removed
}
