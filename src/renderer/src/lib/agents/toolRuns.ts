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

/**
 * Consecutive calls to one tool that read as a single block of work — a run of browser
 * commands driving one page — kept together whatever their status, so the block can show
 * them as the one thing they did.
 */
export interface CallGroupRow {
  kind: 'callGroup'
  key: string
  /** What the caller named the group: the tool its calls share. */
  group: string
  items: ToolItem[]
}

export type TranscriptRow = ItemRow | ToolRunRow | CallGroupRow

/** One tool name and how many times the run called it. */
export interface ToolTally {
  name: string
  count: number
  /** The file names its calls were about, once each, in the order they came. */
  files: string[]
}

/**
 * Whether a call is finished and uneventful enough to disappear into a summary. A call the
 * caller says stands alone (an edit, one that returned an image) never is.
 */
function isFoldable(
  item: TranscriptItem,
  standsAlone: (call: ToolItem) => boolean
): item is ToolItem {
  return item.kind === 'tool' && item.status === 'ok' && !standsAlone(item)
}

/**
 * The render list: every item in order, with runs of settled tool calls replaced by one row.
 * `standsAlone` names the calls that keep a row of their own and break a run. `groupOf` names
 * the group a call belongs to, or null; two or more consecutive calls of one group become a
 * single group row, and a lone one is treated like any other call.
 */
export function toTranscriptRows(
  items: TranscriptItem[],
  standsAlone: (call: ToolItem) => boolean = () => false,
  groupOf: (call: ToolItem) => string | null = () => null
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let run: ToolItem[] = []
  let group: ToolItem[] = []
  let groupName = ''

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

  const place = (item: TranscriptItem): void => {
    if (isFoldable(item, standsAlone)) {
      run.push(item)
      return
    }
    flush()
    rows.push({ kind: 'item', key: item.eventId, item })
  }

  // A group of one is just a call, so it only becomes a row once a second call joins it.
  const closeGroup = (): void => {
    if (group.length >= MIN_RUN) {
      flush()
      rows.push({ kind: 'callGroup', key: `group:${group[0].eventId}`, group: groupName, items: group })
    } else {
      group.forEach(place)
    }
    group = []
  }

  for (const item of items) {
    const name = groupNameOf(item, groupOf)
    if (name !== null && group.length > 0 && name !== groupName) {
      closeGroup()
    }
    if (name !== null) {
      groupName = name
      group.push(item as ToolItem)
      continue
    }
    closeGroup()
    place(item)
  }
  closeGroup()
  flush()
  return rows
}

/**
 * The group a transcript item joins, or null. A call still waiting on the user's approval
 * joins none: it is the reason to read the transcript, so it keeps a row of its own.
 */
function groupNameOf(
  item: TranscriptItem,
  groupOf: (call: ToolItem) => string | null
): string | null {
  if (item.kind !== 'tool' || item.status === 'pending') {
    return null
  }
  return groupOf(item)
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
 * One turn's rows. The turn in flight shows every item on a row of its own — no
 * runs, no groups — so nothing the user is watching folds away under them; a
 * settled turn folds its runs of finished calls as `toTranscriptRows` does.
 */
export function turnRows(
  items: TranscriptItem[],
  settled: boolean,
  standsAlone: (call: ToolItem) => boolean = () => false,
  groupOf: (call: ToolItem) => string | null = () => null
): TranscriptRow[] {
  if (!settled) return toItemRows(items)
  return toTranscriptRows(items, standsAlone, groupOf)
}

/**
 * What the run did, by tool name, in the order the names first appeared.
 *
 * Nothing here knows any tool: the harness decides what its tools are called, so the summary
 * counts whatever names came back rather than mapping them to phrases grove made up. A call
 * about a file keeps its file name through the fold, since "Read" alone does not say what
 * was read; `fileOf` is how the caller, which knows the tools, says which file that is.
 * `nameOf` is what a call is called there, for a tool that names itself in words.
 */
export function tallyOf(
  items: ToolItem[],
  fileOf: (item: ToolItem) => string | null = () => null,
  nameOf: (item: ToolItem) => string = (item) => item.name
): ToolTally[] {
  const tallies: ToolTally[] = []
  for (const item of items) {
    const name = nameOf(item)
    let tally = tallies.find((existing) => existing.name === name)
    if (tally) {
      tally.count += 1
    } else {
      tally = { name, count: 1, files: [] }
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
