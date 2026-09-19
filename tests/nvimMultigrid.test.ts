import { describe, expect, test } from 'bun:test'
import {
  applyMultigridRedraw,
  createMultigridState,
  nvimGridSpan,
  resolveNvimWindowPosition
} from '../src/renderer/src/lib/nvim/multigrid'
import type { NvimWindowPlacement } from '../src/renderer/src/lib/nvim/multigrid'

/** A normal window at a place in the outer grid, with the rest defaulted. */
function placement(
  win: number,
  col: number,
  width: number,
  row = 0,
  height = 39
): NvimWindowPlacement {
  return {
    grid: win - 998,
    win,
    kind: 'normal',
    row,
    col,
    width,
    height,
    focusable: true,
    zindex: 0,
    hidden: false
  }
}

describe('nvim multigrid routing', () => {
  test('routes cells to separate grids and identifies the primary window', () => {
    const state = createMultigridState()
    const dirty = applyMultigridRedraw(state, [
      ['grid_resize', [2, 20, 10], [3, 8, 4]],
      ['win_pos', [2, 1000, 0, 0, 20, 10], [3, 1001, 0, 20, 8, 4]],
      ['grid_line', [3, 0, 0, [['x']], false]],
      ['flush', []]
    ])
    expect(state.primaryGrid).toBe(2)
    expect(state.grids.get(3)?.lines[0][0].text).toBe('x')
    expect(dirty.grids.get(3)?.rows.has(0)).toBe(true)
    expect(dirty.flushed).toBe(true)
  })

  test('tracks float placement and lifecycle', () => {
    const state = createMultigridState()
    applyMultigridRedraw(state, [
      ['grid_resize', [4, 30, 6]],
      ['win_float_pos', [4, 1002, 'NW', 1, 3.5, 5, true, 80, 2, 8, 13]]
    ])
    expect(state.windows.get(4)).toMatchObject({
      kind: 'float',
      row: 3.5,
      col: 5,
      zindex: 80,
      compindex: 2,
      screenRow: 8,
      screenCol: 13
    })
    applyMultigridRedraw(state, [['win_hide', [4]]])
    expect(state.windows.get(4)?.hidden).toBe(true)
    applyMultigridRedraw(state, [['grid_destroy', [4]]])
    expect(state.windows.has(4)).toBe(false)
    expect(state.grids.has(4)).toBe(false)
  })

  test('moves primary rendering to the visible tab window', () => {
    const state = createMultigridState()
    applyMultigridRedraw(state, [
      ['win_pos', [2, 1000, 0, 0, 20, 10]],
      ['win_pos', [3, 1001, 0, 20, 20, 10]]
    ])
    expect(state.primaryGrid).toBe(2)
    applyMultigridRedraw(state, [
      ['win_hide', [2]],
      ['win_hide', [3]]
    ])
    expect(state.primaryGrid).toBeNull()
    applyMultigridRedraw(state, [['win_pos', [4, 1002, 0, 0, 40, 10]]])
    expect(state.primaryGrid).toBe(4)
  })

  test('tracks the in-grid command line message row', () => {
    const state = createMultigridState()
    applyMultigridRedraw(state, [
      ['grid_resize', [3, 80, 53]],
      ['msg_set_pos', [3, 52, false, ' ']],
      ['grid_cursor_goto', [3, 0, 1]]
    ])
    expect(state.windows.get(3)).toMatchObject({ kind: 'message', row: 52, height: 1 })
    expect(state.cursorGrid).toBe(3)
    applyMultigridRedraw(state, [['msg_set_pos', [0, 52, false, ' ']]])
    expect([...state.windows.values()].some((entry) => entry.kind === 'message')).toBe(false)
  })

  test('updates float dimensions when float grid resizes', () => {
    const state = createMultigridState()
    applyMultigridRedraw(state, [
      ['grid_resize', [5, 40, 15]],
      ['win_float_pos', [5, 1003, 'NW', 1, 2, 4, true, 50]]
    ])
    expect(state.windows.get(5)).toMatchObject({ kind: 'float', width: 40, height: 15 })
    applyMultigridRedraw(state, [['grid_resize', [5, 60, 20]]])
    expect(state.windows.get(5)).toMatchObject({ kind: 'float', width: 60, height: 20 })
  })

  test('resolves nested float anchors when nvim omits final screen coordinates', () => {
    const state = createMultigridState()
    applyMultigridRedraw(state, [
      ['grid_resize', [2, 80, 40], [4, 10, 4], [5, 20, 8]],
      ['win_pos', [2, 1000, 2, 3, 80, 40]],
      ['win_float_pos', [4, 1002, 'NW', 2, 10, 5, true, 1001]],
      ['win_float_pos', [5, 1003, 'NW', 4, 1, 10, true, 1001]]
    ])
    const docs = state.windows.get(5)!
    expect(resolveNvimWindowPosition(state.windows.values(), docs)).toEqual({ row: 13, col: 18 })
  })
})

// What a pane maps its own columns against. Getting this wrong is what draws a
// 43-column window across 87 columns of pane, with every glyph on top of the
// one before it.
describe('nvimGridSpan', () => {
  const outer = { col: 0, cols: 87, row: 0, rows: 40 }

  test('is the whole grid when the pane draws nothing of its own', () => {
    expect(nvimGridSpan([], outer)).toEqual(outer)
  })

  test('is the one window when the rest are mirrored into other panes', () => {
    const span = nvimGridSpan([placement(1000, 44, 43)], outer)
    expect(span.col).toBe(44)
    expect(span.cols).toBe(43)
  })

  test('covers a window embedded beside the primary one', () => {
    const span = nvimGridSpan([placement(1000, 44, 43), placement(1002, 0, 43)], outer)
    expect(span.col).toBe(0)
    expect(span.cols).toBe(87)
  })

  test('reaches down to the cmdline row', () => {
    const span = nvimGridSpan([placement(1000, 0, 87)], outer, 39)
    expect(span.rows).toBe(40)
  })

  // renderState composites the cmdline onto the primary grid wherever that grid
  // is, so the slice has to reach it even when the window itself stops short.
  test('reaches the cmdline from a window that stops above it', () => {
    const span = nvimGridSpan([placement(1000, 0, 87, 0, 20)], outer, 39)
    expect(span.row).toBe(0)
    expect(span.rows).toBe(40)
  })
})
