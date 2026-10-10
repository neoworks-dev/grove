/**
 * The panel under the prompt that lists the session and the agents it is running:
 * what state each is in, which stay on screen and for how long, and which five
 * rows of a longer list are shown.
 */

import type { SessionBadge } from './sessions.svelte'
import type { IdleReason, SessionStatus } from './types'

export type PanelState = 'running' | 'waiting' | 'idle' | 'finished' | 'failed' | 'stopped'

export interface PanelRow {
  sessionId: string
  title: string
  /** The session the user started, which heads the list. */
  isMain: boolean
  /** The agent was run by the harness inside a tool call, so only its parent's turn can be stopped. */
  harnessRun: boolean
  state: PanelState
}

/** How long a failed, stopped or idle agent stays listed. */
export const SETTLED_VISIBLE_MS = 30000

/** The most rows the panel shows at once. */
export const MAX_PANEL_ROWS = 5

/** What an agent is doing, from its status, how its last turn ended and its badge. */
export function panelStateOf(
  status: SessionStatus,
  stopReason: IdleReason | null,
  badge: SessionBadge
): PanelState {
  if (badge === 'requires_action') return 'waiting'
  if (badge === 'running') return 'running'
  if (badge === 'error') return 'failed'
  if (status === 'terminated' && stopReason === 'aborted') return 'stopped'
  if (status === 'terminated') return 'finished'
  return 'idle'
}

/** Whether an agent in this state is still going, so it stays listed until it is over. */
export function isActiveState(state: PanelState): boolean {
  return state === 'running' || state === 'waiting'
}

/**
 * The state of an agent the harness ran inside a tool call. Such an agent is never
 * marked running itself: it has no run of its own, and is working for as long as the
 * session that started it is on the turn it was started in and the call has not
 * returned. One still unfinished when that turn is over was cut off with it.
 */
export function harnessRunStateOf(
  own: PanelState,
  mainState: PanelState,
  startedInCurrentTurn: boolean
): PanelState {
  if (own !== 'idle') return own
  if (isActiveState(mainState) && startedInCurrentTurn) return 'running'
  return 'stopped'
}

/**
 * Whether an agent's row is listed. A running one always is, and one that finished
 * well never is; one that failed, was stopped or sat idle stays for SETTLED_VISIBLE_MS
 * from when it got there, or until the user dismisses it.
 */
export function isRowListed(
  state: PanelState,
  settledAt: number | undefined,
  now: number,
  dismissed: boolean
): boolean {
  if (dismissed) return false
  if (isActiveState(state)) return true
  if (state === 'finished') return false
  if (settledAt === undefined) return true
  return now - settledAt < SETTLED_VISIBLE_MS
}

export interface RowWindow {
  /** The rows in view, at most MAX_PANEL_ROWS. */
  rows: PanelRow[]
  /** The index in the full list of the first row in view. */
  start: number
  /** How many rows lie below the ones in view. */
  hiddenBelow: number
}

/** The slice of rows to show so that the selected one is in it. */
export function windowRows(rows: PanelRow[], selected: number): RowWindow {
  if (rows.length <= MAX_PANEL_ROWS) return { rows, start: 0, hiddenBelow: 0 }
  let start = selected - MAX_PANEL_ROWS + 1
  if (start < 0) start = 0
  if (start > rows.length - MAX_PANEL_ROWS) start = rows.length - MAX_PANEL_ROWS
  const shown = rows.slice(start, start + MAX_PANEL_ROWS)
  return { rows: shown, start, hiddenBelow: rows.length - start - MAX_PANEL_ROWS }
}

/** The row to move to from `selected`, kept inside the list. */
export function movedSelection(selected: number, direction: 1 | -1, rowCount: number): number {
  const next = selected + direction
  if (next < 0) return 0
  if (next > rowCount - 1) return rowCount - 1
  return next
}
