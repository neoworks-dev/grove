import { expect, test } from 'bun:test'
import { draggedCells, splitDividers } from '../src/renderer/src/lib/nvim/splitDividers'
import type { NvimWindowPlacement } from '../src/renderer/src/lib/nvim/multigrid'

/** A normal window at a cell box. */
function window(win: number, col: number, row: number, width: number, height: number): NvimWindowPlacement {
  return { grid: win + 1000, win, kind: 'normal', col, row, width, height, hidden: false } as NvimWindowPlacement
}

test('a vertical split has one divider, owned by the left window', () => {
  const left = window(1, 0, 0, 40, 30)
  const right = window(2, 41, 0, 39, 30)
  expect(splitDividers([left, right]).map((divider) => [divider.orientation, divider.before.win, divider.after.win])).toEqual([
    ['vertical', 1, 2]
  ])
})

test('a stacked split has one divider, owned by the upper window', () => {
  const upper = window(1, 0, 0, 80, 14)
  const lower = window(2, 0, 15, 80, 15)
  expect(splitDividers([upper, lower]).map((divider) => [divider.orientation, divider.before.win, divider.after.win])).toEqual([
    ['horizontal', 1, 2]
  ])
})

test('windows stacked beside a column each get their segment of the divider', () => {
  const left = window(1, 0, 0, 40, 30)
  const rightTop = window(2, 41, 0, 39, 14)
  const rightBottom = window(3, 41, 15, 39, 15)
  expect(splitDividers([left, rightTop, rightBottom]).map((divider) => divider.key)).toEqual([
    'v:2',
    'v:3',
    'h:3'
  ])
})

test('floats and hidden windows get no divider', () => {
  const main = window(1, 0, 0, 40, 30)
  const float = { ...window(2, 41, 0, 20, 5), kind: 'float' } as NvimWindowPlacement
  const hidden = { ...window(3, 41, 0, 39, 30), hidden: true } as NvimWindowPlacement
  expect(splitDividers([main, float, hidden])).toEqual([])
})

test('a drag resizes in whole cells and never below one', () => {
  expect(draggedCells(40, 35, 8)).toBe(44)
  expect(draggedCells(40, -3, 8)).toBe(40)
  expect(draggedCells(4, -100, 8)).toBe(1)
})
