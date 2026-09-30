// The dividers between an editor pane's nvim splits. nvim draws its separators
// on its base grid, which the pane does not paint, so the pane draws a divider
// of its own for each: a line to see, a handle to drag and a `+` to split.
// Kept free of the DOM so the geometry can be tested on its own.

import type { NvimWindowPlacement } from './multigrid'

export type DividerOrientation = 'vertical' | 'horizontal'

export interface SplitDivider {
  key: string
  orientation: DividerOrientation
  // The window left of (vertical) or above (horizontal) the separator: the one
  // a drag resizes and the `+` splits, as nvim does when its own separator is
  // dragged.
  before: NvimWindowPlacement
  // The window on the other side; the divider runs along its edge.
  after: NvimWindowPlacement
}

/** Whether two spans of cells [start, start + length) overlap. */
function overlaps(startA: number, lengthA: number, startB: number, lengthB: number): boolean {
  return startA < startB + lengthB && startB < startA + lengthA
}

/** The window whose right edge meets the separator column left of `window`. */
function leftNeighbour(
  window: NvimWindowPlacement,
  windows: NvimWindowPlacement[]
): NvimWindowPlacement | null {
  const found = windows.find(
    (candidate) =>
      candidate.col + candidate.width + 1 === window.col &&
      overlaps(candidate.row, candidate.height, window.row, window.height)
  )
  if (found === undefined) return null
  return found
}

/** The window whose bottom edge meets the separator row above `window`. */
function upperNeighbour(
  window: NvimWindowPlacement,
  windows: NvimWindowPlacement[]
): NvimWindowPlacement | null {
  const found = windows.find(
    (candidate) =>
      candidate.row + candidate.height + 1 === window.row &&
      overlaps(candidate.col, candidate.width, window.col, window.width)
  )
  if (found === undefined) return null
  return found
}

/**
 * One divider along the left and top edge of every split that has a neighbour
 * there. Floats and hidden windows take no part in the layout.
 */
export function splitDividers(windows: NvimWindowPlacement[]): SplitDivider[] {
  const splits = windows.filter((entry) => entry.kind === 'normal' && !entry.hidden)
  const dividers: SplitDivider[] = []
  for (const window of splits) {
    const left = leftNeighbour(window, splits)
    if (left !== null) {
      dividers.push({ key: `v:${window.win}`, orientation: 'vertical', before: left, after: window })
    }
    const upper = upperNeighbour(window, splits)
    if (upper !== null) {
      dividers.push({ key: `h:${window.win}`, orientation: 'horizontal', before: upper, after: window })
    }
  }
  return dividers
}

/**
 * The size, in cells, a window dragged by `pixelDelta` from `startCells` should
 * take: whole cells only, and never under one.
 */
export function draggedCells(startCells: number, pixelDelta: number, cellPixels: number): number {
  if (cellPixels <= 0) return startCells
  return Math.max(1, startCells + Math.round(pixelDelta / cellPixels))
}
