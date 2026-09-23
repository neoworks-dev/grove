/**
 * Consecutive tool calls → one collapsed row.
 *
 * A transcript is mostly tool calls, and a burst of them says one thing ("it read the theme
 * files") across a dozen lines. A run of settled calls therefore folds into a single summary
 * that expands back into the individual calls.
 *
 * Only settled calls fold. A call that is pending, running, denied or failed is the reason the
 * transcript is being read at all, so it breaks the run and renders on its own line.
 */

import type { ToolItem, TranscriptItem } from './transcript'

/** Below this a run says no less than the calls themselves, so it is not worth folding. */
const MIN_RUN = 2

export interface ToolRunRow {
  kind: 'toolRun'
  key: string
  items: ToolItem[]
}

export interface ItemRow {
  kind: 'item'
  key: string
  item: TranscriptItem
}

export type TranscriptRow = ItemRow | ToolRunRow

/** One tool name and how many times the run called it. */
export interface ToolTally {
  name: string
  count: number
  /** The file names its calls were about, once each, in the order they came. */
  files: string[]
}

/** Whether a call is finished and uneventful enough to disappear into a summary. */
function isFoldable(item: TranscriptItem): item is ToolItem {
  return item.kind === 'tool' && item.status === 'ok'
}

/**
 * The render list: every item in order, with runs of settled tool calls replaced by one row.
 */
export function toTranscriptRows(items: TranscriptItem[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let run: ToolItem[] = []

  const flush = (): void => {
    if (run.length === 0) return
    if (run.length >= MIN_RUN) {
      rows.push({ kind: 'toolRun', key: `run:${run[0].eventId}`, items: run })
    } else {
      for (const call of run) {
        rows.push({ kind: 'item', key: call.eventId, item: call })
      }
    }
    run = []
  }

  for (const item of items) {
    if (isFoldable(item)) {
      run.push(item)
      continue
    }
    flush()
    rows.push({ kind: 'item', key: item.eventId, item })
  }
  flush()
  return rows
}

/**
 * Every item as its own row, nothing folded.
 *
 * What an opened turn shows: it already summarised its work in one line, and folding runs
 * inside it again would answer "what did it do" with a second row that looks just like the first.
 */
export function toItemRows(items: TranscriptItem[]): TranscriptRow[] {
  return items.map((item) => ({ kind: 'item', key: item.eventId, item }))
}

/**
 * What the run did, by tool name, in the order the names first appeared.
 *
 * Nothing here knows any tool: the harness decides what its tools are called, so the summary
 * counts whatever names came back rather than mapping them to phrases grove made up. A call
 * about a file keeps its file name through the fold, since "Read" alone does not say what
 * was read; `fileOf` is how the caller, which knows the tools, says which file that is.
 */
export function tallyOf(
  items: ToolItem[],
  fileOf: (item: ToolItem) => string | null = () => null
): ToolTally[] {
  const tallies: ToolTally[] = []
  for (const item of items) {
    let tally = tallies.find((existing) => existing.name === item.name)
    if (tally) {
      tally.count += 1
    } else {
      tally = { name: item.name, count: 1, files: [] }
      tallies.push(tally)
    }
    addFileName(tally, fileOf(item))
  }
  return tallies
}

/** Adds a path's file name to a tally, once. */
function addFileName(tally: ToolTally, path: string | null): void {
  if (path === null) {
    return
  }
  const name = path.split('/').pop() || path
  if (!tally.files.includes(name)) {
    tally.files.push(name)
  }
}
