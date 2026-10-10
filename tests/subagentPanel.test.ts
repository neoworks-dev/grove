// The panel of agents under the prompt: which rows stay listed and for how long,
// which five of a longer list are in view, and how a harness-run agent is judged.

import { describe, expect, test } from 'bun:test'
import {
  MAX_PANEL_ROWS,
  SETTLED_VISIBLE_MS,
  harnessRunStateOf,
  isRowListed,
  movedSelection,
  panelStateOf,
  windowRows,
  type PanelRow
} from '../src/renderer/src/lib/agents/subagentPanel'

/** A row with only what the window cares about. */
function row(index: number): PanelRow {
  return {
    sessionId: `s${index}`,
    title: `Agent ${index}`,
    isMain: index === 0,
    harnessRun: false,
    state: 'running'
  }
}

describe('isRowListed', () => {
  test('a running agent is always listed and one that finished well never is', () => {
    expect(isRowListed('running', undefined, 0, false)).toBe(true)
    expect(isRowListed('finished', 0, 0, false)).toBe(false)
  })

  test('a failed agent stays for 30 seconds, or until it is dismissed', () => {
    expect(isRowListed('failed', 1000, 1000 + SETTLED_VISIBLE_MS - 1, false)).toBe(true)
    expect(isRowListed('failed', 1000, 1000 + SETTLED_VISIBLE_MS, false)).toBe(false)
    expect(isRowListed('failed', 1000, 2000, true)).toBe(false)
  })

  test('an idle agent hides after 30 seconds too', () => {
    expect(isRowListed('idle', 0, SETTLED_VISIBLE_MS, false)).toBe(false)
  })
})

describe('windowRows', () => {
  const rows = [0, 1, 2, 3, 4, 5, 6].map(row)

  test('shows five rows and counts the rest', () => {
    const view = windowRows(rows, 0)
    expect(view.rows).toHaveLength(MAX_PANEL_ROWS)
    expect(view.hiddenBelow).toBe(2)
  })

  test('follows the selection down and keeps it in view', () => {
    const view = windowRows(rows, 6)
    expect(view.rows.map((shown) => shown.sessionId)).toEqual(['s2', 's3', 's4', 's5', 's6'])
    expect(view.hiddenBelow).toBe(0)
  })

  test('a short list is shown whole', () => {
    expect(windowRows(rows.slice(0, 3), 2).hiddenBelow).toBe(0)
  })
})

describe('movedSelection', () => {
  test('stays inside the list', () => {
    expect(movedSelection(0, -1, 3)).toBe(0)
    expect(movedSelection(2, 1, 3)).toBe(2)
    expect(movedSelection(1, 1, 3)).toBe(2)
  })
})

describe('agent states', () => {
  test('an error is a failure, an abort a stop, and a clean end a finish', () => {
    expect(panelStateOf('idle', 'error', 'error')).toBe('failed')
    expect(panelStateOf('terminated', 'aborted', 'idle')).toBe('stopped')
    expect(panelStateOf('terminated', null, 'idle')).toBe('finished')
    expect(panelStateOf('idle', 'end_turn', 'running')).toBe('running')
  })

  test('a harness-run agent works while its starting turn does, and is stopped when the turn ends', () => {
    expect(harnessRunStateOf('idle', 'running', true)).toBe('running')
    expect(harnessRunStateOf('idle', 'idle', true)).toBe('stopped')
    expect(harnessRunStateOf('idle', 'running', false)).toBe('stopped')
    expect(harnessRunStateOf('finished', 'running', true)).toBe('finished')
  })
})
