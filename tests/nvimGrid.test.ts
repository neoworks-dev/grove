import { describe, expect, test } from 'bun:test'
import { createGridState } from '../src/renderer/src/lib/nvim/types'
import { applyRedraw } from '../src/renderer/src/lib/nvim/grid'

function resized(cols = 10, rows = 4): ReturnType<typeof createGridState> {
  const state = createGridState()
  applyRedraw(state, [['grid_resize', [1, cols, rows]]])
  return state
}

function rowText(state: ReturnType<typeof createGridState>, row: number): string {
  return state.lines[row].map((cell) => cell.text).join('')
}

describe('applyRedraw', () => {
  test('grid_resize allocates empty rows and marks all dirty', () => {
    const state = createGridState()
    const dirty = applyRedraw(state, [['grid_resize', [1, 8, 3]]])
    expect(state.cols).toBe(8)
    expect(state.rows).toBe(3)
    expect(state.lines).toHaveLength(3)
    expect(rowText(state, 0)).toBe(' '.repeat(8))
    expect(dirty.all).toBe(true)
  })

  test('grid_line expands repeats and carries hl_id over', () => {
    const state = resized()
    const dirty = applyRedraw(state, [
      ['grid_line', [1, 1, 0, [['h', 5], ['i'], [' ', 2, 3], ['!', 7]], false]]
    ])
    expect(rowText(state, 1)).toBe('hi   !    ')
    expect(state.lines[1][0].hlId).toBe(5)
    expect(state.lines[1][1].hlId).toBe(5)
    expect(state.lines[1][2].hlId).toBe(2)
    expect(state.lines[1][4].hlId).toBe(2)
    expect(state.lines[1][5].hlId).toBe(7)
    expect(dirty.rows.has(1)).toBe(true)
  })

  test('multiple grid_line tuples in one event apply in order', () => {
    const state = resized()
    applyRedraw(state, [
      [
        'grid_line',
        [1, 0, 0, [['a']], false],
        [1, 2, 0, [['b']], false]
      ]
    ])
    expect(state.lines[0][0].text).toBe('a')
    expect(state.lines[2][0].text).toBe('b')
  })

  test('grid_scroll up moves rows toward top and dirties region', () => {
    const state = resized(4, 4)
    applyRedraw(state, [
      [
        'grid_line',
        [1, 0, 0, [['0']], false],
        [1, 1, 0, [['1']], false],
        [1, 2, 0, [['2']], false],
        [1, 3, 0, [['3']], false]
      ]
    ])
    const dirty = applyRedraw(state, [['grid_scroll', [1, 0, 4, 0, 4, 1, 0]]])
    expect(state.lines[0][0].text).toBe('1')
    expect(state.lines[1][0].text).toBe('2')
    expect(state.lines[2][0].text).toBe('3')
    expect(dirty.rows.has(0)).toBe(true)
    expect(dirty.rows.has(3)).toBe(true)
  })

  test('grid_scroll down moves rows toward bottom', () => {
    const state = resized(4, 4)
    applyRedraw(state, [
      [
        'grid_line',
        [1, 0, 0, [['0']], false],
        [1, 1, 0, [['1']], false],
        [1, 2, 0, [['2']], false],
        [1, 3, 0, [['3']], false]
      ]
    ])
    applyRedraw(state, [['grid_scroll', [1, 0, 4, 0, 4, -1, 0]]])
    expect(state.lines[1][0].text).toBe('0')
    expect(state.lines[2][0].text).toBe('1')
    expect(state.lines[3][0].text).toBe('2')
  })

  test('grid_resize preserves top-left content', () => {
    const state = resized(4, 2)
    applyRedraw(state, [['grid_line', [1, 0, 0, [['x', 1, 4]], false]]])
    applyRedraw(state, [['grid_resize', [1, 6, 3]]])
    expect(rowText(state, 0)).toBe('xxxx  ')
    expect(state.lines).toHaveLength(3)
  })

  test('cursor, mode and busy events update state', () => {
    const state = resized()
    applyRedraw(state, [
      ['grid_cursor_goto', [1, 2, 5]],
      ['mode_info_set', [true, [{ name: 'normal', cursor_shape: 'block' }, { name: 'insert', cursor_shape: 'vertical', cell_percentage: 25 }]]],
      ['mode_change', ['insert', 1]],
      ['busy_start', []]
    ])
    expect(state.cursor).toMatchObject({ row: 2, col: 5, visible: false })
    expect(state.modeName).toBe('insert')
    expect(state.modes[1].cursorShape).toBe('vertical')
    expect(state.modes[1].cellPercentage).toBe(25)
    applyRedraw(state, [['busy_stop', []]])
    expect(state.cursor.visible).toBe(true)
  })

  test('default_colors_set updates defaults, ignores -1', () => {
    const state = resized()
    applyRedraw(state, [['default_colors_set', [0xaabbcc, 0x112233, -1, 0, 0]]])
    expect(state.defaults.fg).toBe(0xaabbcc)
    expect(state.defaults.bg).toBe(0x112233)
    expect(state.defaults.sp).not.toBe(-1)
  })

  test('flush sets flushed; unknown events are ignored', () => {
    const state = resized()
    const dirty = applyRedraw(state, [
      ['win_viewport', [1, 'x', 0, 10, 0, 0]],
      ['set_title', [['hello']]],
      ['flush', []]
    ])
    expect(dirty.flushed).toBe(true)
    expect(dirty.rows.size).toBe(0)
  })

  test('grid_clear blanks all cells', () => {
    const state = resized(4, 2)
    applyRedraw(state, [['grid_line', [1, 0, 0, [['x', 1, 4]], false]]])
    const dirty = applyRedraw(state, [['grid_clear', [1]]])
    expect(rowText(state, 0)).toBe('    ')
    expect(dirty.all).toBe(true)
  })
})
