// Minimap math for the embedded Neovim pane. nvim gives us buffer text plus a
// window view (topline/botline over a total line count) rather than pixel
// scroll geometry, so the geometry here is line-based. Kept DOM-free and pure
// for unit testing.

// A horizontal stretch of one line drawn in a single color. Columns are
// character offsets from the line start, capped at MAX_COLS.
export interface LineRun {
  fromCol: number
  toCol: number
  color: string
}

export const LINE_PITCH = 3
export const GLYPH_HEIGHT = 2
export const COL_WIDTH = 0.6
export const MAX_COLS = 120

export interface MinimapGeometry {
  // Height of the whole map in CSS px (total lines * LINE_PITCH).
  contentHeight: number
  // How far the content is slid up when taller than the canvas.
  mapScrollTop: number
  indicatorTop: number
  indicatorHeight: number
}

// A highlighted span within one line, as returned by the nvim treesitter pass:
// [startCol, endCol, cssColor].
export type ColorSpan = [number, number, string]

// Colored runs from per-line treesitter spans (empty where a language/parser is
// unavailable — the monochrome base still draws the text shape underneath).
export function buildColoredRuns(spans: ColorSpan[][]): LineRun[][] {
  return spans.map((line) => {
    const runs: LineRun[] = []
    if (!Array.isArray(line)) return runs
    for (const [start, end, color] of line) {
      if (start >= MAX_COLS) continue
      const toCol = Math.min(end, MAX_COLS)
      if (toCol > start) runs.push({ fromCol: start, toCol, color })
    }
    return runs
  })
}

// One monochrome run per non-whitespace chunk so the map keeps the text shape
// (indentation and gaps stay visible), capped at MAX_COLS.
export function buildLineRuns(lines: string[], color: string): LineRun[][] {
  return lines.map((text) => {
    const runs: LineRun[] = []
    const capped = text.slice(0, MAX_COLS)
    const chunkPattern = /\S+/g
    let match = chunkPattern.exec(capped)
    while (match !== null) {
      runs.push({ fromCol: match.index, toCol: match.index + match[0].length, color })
      match = chunkPattern.exec(capped)
    }
    return runs
  })
}

export function computeGeometry(
  total: number,
  topline: number,
  botline: number,
  canvasHeight: number
): MinimapGeometry {
  const lines = Math.max(1, total)
  const contentHeight = lines * LINE_PITCH
  const visibleLines = Math.max(1, botline - topline + 1)
  const maxTop = Math.max(0, lines - visibleLines)
  const scrollRatio = maxTop > 0 ? (topline - 1) / maxTop : 0
  const mapScrollTop = Math.max(0, contentHeight - canvasHeight) * scrollRatio
  const indicatorHeight = Math.min(canvasHeight, visibleLines * LINE_PITCH)
  const indicatorTop = (topline - 1) * LINE_PITCH - mapScrollTop
  return { contentHeight, mapScrollTop, indicatorTop, indicatorHeight }
}

// Invert a canvas y coordinate to the buffer line that should sit at the top of
// the viewport, clamped to [1, total].
export function toplineForY(y: number, mapScrollTop: number, total: number): number {
  const line = Math.round((y + mapScrollTop) / LINE_PITCH) + 1
  return Math.max(1, Math.min(line, Math.max(1, total)))
}

// Keep the cursor line inside the new viewport after a scroll so nvim doesn't
// yank the view back to follow an off-screen cursor.
export function clampCursorLine(
  lnum: number,
  topline: number,
  visibleLines: number,
  total: number
): number {
  const bottom = Math.min(total, topline + Math.max(1, visibleLines) - 1)
  return Math.max(topline, Math.min(lnum, bottom))
}
