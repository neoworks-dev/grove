/**
 * A finished turn → its answer, with the work behind it folded away.
 *
 * Reading a transcript afterwards means reading what the agent concluded, not the dozen tool
 * calls and interim notes it took to get there. Once a turn is done those rows collapse into one
 * summary line that expands back into the full sequence.
 *
 * Rows that still want the user do not fold: a failed or pending call, a notice, an
 * application-authored message. They are the reason the turn is worth looking at.
 */

import type { ToolItem, TranscriptItem } from './transcript'
import type { TranscriptRow } from './toolRuns'

export interface TurnFold {
  /** The work leading to the answer; hidden while the turn is collapsed. */
  hidden: TranscriptRow[]
  /** The answer and anything that still needs the user; always on screen. */
  kept: TranscriptRow[]
}

/** The agent's own prose — the thing a collapsed turn is reduced to. */
function isAnswer(row: TranscriptRow): boolean {
  return row.kind === 'item' && row.item.kind === 'agent' && row.item.text.length > 0
}

/**
 * Rows that are the turn working rather than talking: settled calls, runs of them, and the
 * agent's interim messages.
 *
 * A call that is pending, running, denied or failed is not work that went well, so it stays
 * out of the fold — as does everything the agent did not author: notices, application
 * messages, the user's own shell commands, harness command output, extension surfaces.
 */
function isWork(row: TranscriptRow, standsAlone: (call: ToolItem) => boolean): boolean {
  if (row.kind === 'toolRun') {
    return true
  }
  const item = row.item
  if (item.kind === 'tool') {
    return item.status === 'ok' && !standsAlone(item)
  }
  return item.kind === 'agent'
}

/**
 * Splits a turn's rows into the ones a collapsed turn hides and the ones it keeps.
 *
 * All of the turn's work folds, wherever it sits — a burst of calls after the answer is as
 * much a detail as one before it, so the whole turn reduces to a single summary line plus the
 * answer. A turn that never produced an answer folds nothing: there would be nothing left.
 * Calls `standsAlone` names (an edit, one that returned an image) stay on screen too.
 */
export function foldTurn(
  rows: TranscriptRow[],
  standsAlone: (call: ToolItem) => boolean = () => false
): TurnFold {
  let lastAnswer = -1
  for (let index = 0; index < rows.length; index++) {
    if (isAnswer(rows[index])) lastAnswer = index
  }
  if (lastAnswer < 0) {
    return { hidden: [], kept: rows }
  }

  const hidden: TranscriptRow[] = []
  const kept: TranscriptRow[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (index !== lastAnswer && isWork(row, standsAlone)) {
      hidden.push(row)
      continue
    }
    kept.push(row)
  }
  return { hidden, kept }
}

/** Every tool call inside the folded rows, run summaries included. */
export function foldedCalls(rows: TranscriptRow[]): ToolItem[] {
  const calls: ToolItem[] = []
  for (const row of rows) {
    if (row.kind === 'toolRun') {
      calls.push(...row.items)
      continue
    }
    if (row.item.kind === 'tool') calls.push(row.item)
  }
  return calls
}

/** Folded rows that are the agent talking rather than working. */
export function foldedMessages(rows: TranscriptRow[]): TranscriptItem[] {
  const messages: TranscriptItem[] = []
  for (const row of rows) {
    if (row.kind !== 'item') continue
    if (row.item.kind === 'agent' && row.item.text.length > 0) messages.push(row.item)
  }
  return messages
}
