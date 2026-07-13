// Renderer contract for the nvim grid. Canvas 2D is the v1 implementation;
// a WebGL glyph-atlas renderer can swap in behind the same interface.

import type { DirtyState, GridState } from './types'
import type { CellMetrics, FontSpec } from './metrics'

export interface GridRenderer {
  attach(canvas: HTMLCanvasElement): void
  setFont(font: FontSpec, metrics: CellMetrics): void
  resize(cols: number, rows: number, dpr: number): void
  render(state: GridState, dirty: DirtyState): void
  dispose(): void
}

export interface CellRun {
  col: number
  width: number
  text: string
  hlId: number
}

// Group a row into runs of consecutive cells sharing a highlight, so the
// renderer draws one background rect and one text call per run. Empty cells
// ('' = right half of a wide char) merge into the preceding run.
export function buildRuns(cells: { text: string; hlId: number }[]): CellRun[] {
  const runs: CellRun[] = []
  let current: CellRun | null = null
  for (let col = 0; col < cells.length; col += 1) {
    const cell = cells[col]
    if (current && (cell.hlId === current.hlId || cell.text === '')) {
      current.width += 1
      current.text += cell.text
      continue
    }
    current = { col, width: 1, text: cell.text, hlId: cell.hlId }
    runs.push(current)
  }
  return runs
}
