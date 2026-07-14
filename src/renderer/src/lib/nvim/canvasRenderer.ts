// Canvas 2D grid renderer: dirty rows are repainted as highlight runs — one
// background rect pass, one text pass, decoration strokes on top, cursor
// last. Device-pixel sizing avoids fractional-cell seams.

import type { DirtyState, GridState } from './types'
import type { CellMetrics, FontSpec } from './metrics'
import type { GridRenderer } from './renderer'
import { buildRuns } from './renderer'
import { highlightAttrs, resolveColors } from './highlights'

interface CellBounds {
  left: number
  top: number
  width: number
  height: number
}

export class CanvasGridRenderer implements GridRenderer {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private font: FontSpec = { family: 'monospace', sizePx: 13 }
  private metrics: CellMetrics = { cellWidth: 8, cellHeight: 18, baseline: 14 }
  private dpr = 1

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
  }

  setFont(font: FontSpec, metrics: CellMetrics): void {
    this.font = font
    this.metrics = metrics
  }

  resize(cols: number, rows: number, dpr: number): void {
    if (!this.canvas) return
    this.dpr = dpr
    const width = Math.round(cols * this.metrics.cellWidth * dpr)
    const height = Math.round(rows * this.metrics.cellHeight * dpr)
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    // Fill the pane: the backing store stays grid-sized (cols*rows cells) but
    // CSS stretches it over the whole host, so any sub-cell remainder on the
    // right/bottom is covered instead of showing a gap.
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
  }

  render(state: GridState, dirty: DirtyState): void {
    if (!this.ctx || !this.canvas) return
    const rows = dirty.all ? allRows(state.rows) : [...dirty.rows]
    for (const row of rows) {
      this.paintRow(state, row)
    }
    if (state.cursor.visible) this.paintCursor(state)
  }

  dispose(): void {
    this.canvas = null
    this.ctx = null
  }

  private cellFont(bold: boolean, italic: boolean): string {
    const weight = bold ? 'bold ' : ''
    const style = italic ? 'italic ' : ''
    return `${style}${weight}${this.font.sizePx * this.dpr}px ${this.font.family}`
  }

  // Pixel bounds of a cell span, snapped to integer backing pixels so adjacent
  // runs/rows tile without a gap and each rect fully contains the content drawn
  // in it. Snapping the top with `round` (the old approach) could start the
  // clear band below the cell's own top edge, leaving the cursor/glyph fringe
  // for a neighbouring row to erase — a stale mark until the next full flush.
  private cellBounds(col: number, width: number, row: number): CellBounds {
    const { cellWidth, cellHeight } = this.metrics
    const dpr = this.dpr
    const left = Math.floor(col * cellWidth * dpr)
    const right = Math.ceil((col + width) * cellWidth * dpr)
    const top = Math.floor(row * cellHeight * dpr)
    const bottom = Math.ceil((row + 1) * cellHeight * dpr)
    return { left, top, width: right - left, height: bottom - top }
  }

  private paintRow(state: GridState, row: number): void {
    const ctx = this.ctx
    const line = state.lines[row]
    if (!ctx || !line) return
    const { cellWidth, cellHeight, baseline } = this.metrics
    const dpr = this.dpr
    const baselineY = row * cellHeight * dpr + baseline * dpr
    const runs = buildRuns(line)

    for (const run of runs) {
      const colors = resolveColors(state, run.hlId)
      const bounds = this.cellBounds(run.col, run.width, row)
      ctx.fillStyle = colors.bg
      ctx.fillRect(bounds.left, bounds.top, bounds.width, bounds.height)
    }

    for (const run of runs) {
      if (run.text.trim() === '') continue
      const attrs = highlightAttrs(state, run.hlId)
      const colors = resolveColors(state, run.hlId)
      const bounds = this.cellBounds(run.col, run.width, row)
      ctx.font = this.cellFont(attrs.bold === true, attrs.italic === true)
      ctx.fillStyle = colors.fg
      ctx.textBaseline = 'alphabetic'
      ctx.save()
      ctx.beginPath()
      ctx.rect(bounds.left, bounds.top, bounds.width, bounds.height)
      ctx.clip()
      // Draw per cell so glyph advance never drifts from the grid.
      let col = run.col
      for (const char of run.text) {
        if (char !== ' ' && char !== '') {
          ctx.fillText(char, col * cellWidth * dpr, baselineY)
        }
        col += char === '' ? 0 : 1
      }
      ctx.restore()
      this.paintDecorations(run.col, run.width, row * cellHeight * dpr, attrs, colors.sp, colors.fg)
    }
  }

  private paintDecorations(
    col: number,
    width: number,
    y: number,
    attrs: { underline?: boolean; undercurl?: boolean; strikethrough?: boolean },
    specialColor: string,
    fgColor: string
  ): void {
    const ctx = this.ctx
    if (!ctx) return
    if (!attrs.underline && !attrs.undercurl && !attrs.strikethrough) return
    const { cellWidth, cellHeight } = this.metrics
    const dpr = this.dpr
    const x0 = col * cellWidth * dpr
    const x1 = (col + width) * cellWidth * dpr
    ctx.lineWidth = Math.max(1, dpr)

    if (attrs.strikethrough) {
      ctx.strokeStyle = fgColor
      const midY = y + (cellHeight * dpr) / 2
      ctx.beginPath()
      ctx.moveTo(x0, midY)
      ctx.lineTo(x1, midY)
      ctx.stroke()
    }
    if (attrs.underline) {
      ctx.strokeStyle = specialColor
      const lineY = y + cellHeight * dpr - ctx.lineWidth
      ctx.beginPath()
      ctx.moveTo(x0, lineY)
      ctx.lineTo(x1, lineY)
      ctx.stroke()
    }
    if (attrs.undercurl) {
      ctx.strokeStyle = specialColor
      const lineY = y + cellHeight * dpr - 2 * dpr
      const amplitude = 1.5 * dpr
      ctx.beginPath()
      for (let x = x0; x <= x1; x += 2 * dpr) {
        const phase = ((x - x0) / (2 * dpr)) % 2 === 0 ? -amplitude : amplitude
        if (x === x0) ctx.moveTo(x, lineY)
        else ctx.lineTo(x, lineY + phase)
      }
      ctx.stroke()
    }
  }

  private paintCursor(state: GridState): void {
    const ctx = this.ctx
    if (!ctx) return
    const { row, col } = state.cursor
    const line = state.lines[row]
    if (!line || col >= line.length) return
    const mode = state.modes[state.modeIdx]
    const shape = mode?.cursorShape ?? 'block'
    const pct = (mode?.cellPercentage ?? 100) / 100
    const { cellWidth, cellHeight, baseline } = this.metrics
    const dpr = this.dpr
    const bounds = this.cellBounds(col, 1, row)
    const baselineY = row * cellHeight * dpr + baseline * dpr
    const cell = line[col]
    const cellColors = resolveColors(state, cell.hlId)

    if (shape === 'vertical') {
      ctx.fillStyle = cellColors.fg
      ctx.fillRect(bounds.left, bounds.top, Math.max(1, cellWidth * pct * dpr), bounds.height)
      return
    }
    if (shape === 'horizontal') {
      ctx.fillStyle = cellColors.fg
      const barHeight = Math.max(1, cellHeight * pct * dpr)
      ctx.fillRect(bounds.left, bounds.top + bounds.height - barHeight, bounds.width, barHeight)
      return
    }
    // Block: reverse video over the cell.
    ctx.fillStyle = cellColors.fg
    ctx.fillRect(bounds.left, bounds.top, bounds.width, bounds.height)
    if (cell.text.trim() !== '') {
      const attrs = highlightAttrs(state, cell.hlId)
      ctx.font = this.cellFont(attrs.bold === true, attrs.italic === true)
      ctx.fillStyle = cellColors.bg
      ctx.textBaseline = 'alphabetic'
      ctx.save()
      ctx.beginPath()
      ctx.rect(bounds.left, bounds.top, bounds.width, bounds.height)
      ctx.clip()
      ctx.fillText(cell.text, col * cellWidth * dpr, baselineY)
      ctx.restore()
    }
  }
}

function allRows(count: number): number[] {
  const rows: number[] = []
  for (let row = 0; row < count; row += 1) rows.push(row)
  return rows
}
