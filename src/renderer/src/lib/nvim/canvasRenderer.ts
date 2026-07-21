// Canvas 2D grid renderer: dirty rows are repainted as highlight runs — one
// background rect pass, one text pass, decoration strokes on top, cursor
// last. Device-pixel sizing avoids fractional-cell seams.

import type { DirtyState, GridState } from './types'
import type { CellMetrics, FontSpec } from './metrics'
import type { GridRenderer } from './renderer'
import { buildRuns } from './renderer'
import { highlightAttrs, resolveColors, rgbToCss } from './highlights'

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
  // Base cell geometry in integer device pixels. Snapping here (instead of
  // scaling fractional CSS metrics per draw) keeps glyph origins on the pixel
  // grid, so text stays crisp instead of subpixel-smeared.
  private cellW = 8
  private cellH = 18
  private baselineDev = 14
  // Column left edges (length cols+1) and row top edges (length rows+1) in
  // device px. The grid can't tile an arbitrary pane with uniform integer
  // cells, so the sub-cell remainder is spread across cells as whole +1px
  // columns/rows (Bresenham-even). Origins stay integer → text stays crisp,
  // and the grid fills the pane exactly — no edge gap, no clipped row.
  private colX: number[] = []
  private rowY: number[] = []

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
  }

  setFont(font: FontSpec, metrics: CellMetrics): void {
    this.font = font
    this.metrics = metrics
  }

  resize(cols: number, rows: number, dpr: number, pxWidth: number, pxHeight: number): void {
    if (!this.canvas) return
    this.dpr = dpr
    // Snap the cell to whole device pixels so glyph origins land on the pixel
    // grid (fractional advance smeared text — the blur).
    this.cellW = Math.max(1, Math.round(this.metrics.cellWidth * dpr))
    this.cellH = Math.max(1, Math.round(this.metrics.cellHeight * dpr))
    this.baselineDev = Math.round(this.metrics.baseline * dpr)
    // Backing store is exactly the host in device px. CSS size is derived from
    // that integer backing, NOT `100%`: at fractional dpr, `100%` makes the
    // browser rescale the backing to the host's CSS box (that rescale is the
    // blur). backing/dpr CSS px maps back to exactly `backing` device px — 1:1,
    // crisp. The grid fills the backing exactly via distributed cell edges
    // (colX/rowY), so there's no sub-cell gap and no row is clipped.
    const width = Math.ceil(pxWidth * dpr)
    const height = Math.ceil(pxHeight * dpr)
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    this.canvas.style.width = `${width / dpr}px`
    this.canvas.style.height = `${height / dpr}px`
    // Spread the backing across cols/rows so every cell is `cellW`/`cellH` or
    // one px larger, distributed evenly — the grid reaches every edge.
    this.colX = buildEdges(cols, width)
    this.rowY = buildEdges(rows, height)
  }

  render(state: GridState, dirty: DirtyState): void {
    if (!this.ctx || !this.canvas) return
    // On a full repaint, clear the whole backing (including the sub-cell
    // remainder the grid doesn't cover) with the editor default bg.
    if (dirty.all) {
      this.ctx.fillStyle = rgbToCss(state.defaults.bg)
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    }
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
    return `${style}${weight}${Math.round(this.font.sizePx * this.dpr)}px ${this.font.family}`
  }

  // Left edge of a column (device px), from the distributed edge table.
  private colLeft(col: number): number {
    const edges = this.colX
    if (edges.length === 0) return col * this.cellW
    if (col <= 0) return 0
    if (col >= edges.length) return edges[edges.length - 1]
    return edges[col]
  }

  // Top edge of a row (device px), from the distributed edge table.
  private rowTop(row: number): number {
    const edges = this.rowY
    if (edges.length === 0) return row * this.cellH
    if (row <= 0) return 0
    if (row >= edges.length) return edges[edges.length - 1]
    return edges[row]
  }

  // Pixel bounds of a cell span. Widths/heights come from the distributed edge
  // tables so adjacent runs/rows tile without a gap and the grid reaches every
  // edge — a cell is `cellW`/`cellH` or one px larger.
  private cellBounds(col: number, width: number, row: number): CellBounds {
    const left = this.colLeft(col)
    const top = this.rowTop(row)
    return {
      left,
      top,
      width: this.colLeft(col + width) - left,
      height: this.rowTop(row + 1) - top
    }
  }

  private paintRow(state: GridState, row: number): void {
    const ctx = this.ctx
    const line = state.lines[row]
    if (!ctx || !line) return
    const baselineY = this.rowTop(row) + this.baselineDev
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
          ctx.fillText(char, this.colLeft(col), baselineY)
        }
        col += char === '' ? 0 : 1
      }
      ctx.restore()
      this.paintDecorations(run.col, run.width, row, attrs, colors.sp, colors.fg)
    }
  }

  private paintDecorations(
    col: number,
    width: number,
    row: number,
    attrs: { underline?: boolean; undercurl?: boolean; strikethrough?: boolean },
    specialColor: string,
    fgColor: string
  ): void {
    const ctx = this.ctx
    if (!ctx) return
    if (!attrs.underline && !attrs.undercurl && !attrs.strikethrough) return
    const dpr = this.dpr
    const x0 = this.colLeft(col)
    const x1 = this.colLeft(col + width)
    const y = this.rowTop(row)
    const cellH = this.rowTop(row + 1) - y
    ctx.lineWidth = Math.max(1, dpr)

    if (attrs.strikethrough) {
      ctx.strokeStyle = fgColor
      const midY = y + cellH / 2
      ctx.beginPath()
      ctx.moveTo(x0, midY)
      ctx.lineTo(x1, midY)
      ctx.stroke()
    }
    if (attrs.underline) {
      ctx.strokeStyle = specialColor
      const lineY = y + cellH - ctx.lineWidth
      ctx.beginPath()
      ctx.moveTo(x0, lineY)
      ctx.lineTo(x1, lineY)
      ctx.stroke()
    }
    if (attrs.undercurl) {
      ctx.strokeStyle = specialColor
      const lineY = y + cellH - 2 * dpr
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
    const bounds = this.cellBounds(col, 1, row)
    const baselineY = this.rowTop(row) + this.baselineDev
    const cell = line[col]
    const cellColors = resolveColors(state, cell.hlId)

    if (shape === 'vertical') {
      ctx.fillStyle = cellColors.fg
      ctx.fillRect(bounds.left, bounds.top, Math.max(1, bounds.width * pct), bounds.height)
      return
    }
    if (shape === 'horizontal') {
      ctx.fillStyle = cellColors.fg
      const barHeight = Math.max(1, bounds.height * pct)
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
      ctx.fillText(cell.text, bounds.left, baselineY)
      ctx.restore()
    }
  }
}

function allRows(count: number): number[] {
  const rows: number[] = []
  for (let row = 0; row < count; row += 1) rows.push(row)
  return rows
}

// Integer boundaries that partition `total` device px into `count` cells as
// evenly as possible (Bresenham). Every edge is integer, so cell origins stay
// snapped and text stays crisp; consecutive widths differ by at most one px,
// so the leftover px are spread across the grid instead of pooling in a gap or
// a clipped edge cell. edges[0] === 0 and edges[count] === total.
export function buildEdges(count: number, total: number): number[] {
  const edges: number[] = []
  for (let index = 0; index <= count; index += 1) {
    edges.push(Math.round((index * total) / count))
  }
  return edges
}
