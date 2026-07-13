// Monospace cell measurement for the nvim grid. The canvas renderer needs
// exact cell dimensions in CSS pixels; device-pixel scaling happens in the
// renderer via the dpr it is given.

export interface CellMetrics {
  cellWidth: number
  cellHeight: number
  baseline: number
}

export interface FontSpec {
  family: string
  sizePx: number
}

export function measureCell(font: FontSpec): CellMetrics {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return { cellWidth: font.sizePx * 0.6, cellHeight: font.sizePx * 1.4, baseline: font.sizePx }
  ctx.font = `${font.sizePx}px ${font.family}`
  const metrics = ctx.measureText('M')
  const ascent = metrics.fontBoundingBoxAscent || font.sizePx * 0.8
  const descent = metrics.fontBoundingBoxDescent || font.sizePx * 0.25
  // Line height padding keeps undercurls and descenders inside the cell.
  const cellHeight = Math.ceil((ascent + descent) * 1.15)
  const pad = (cellHeight - (ascent + descent)) / 2
  return {
    cellWidth: Math.max(1, metrics.width),
    cellHeight,
    baseline: Math.round(ascent + pad)
  }
}
