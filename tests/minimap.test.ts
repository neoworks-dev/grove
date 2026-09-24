import { describe, expect, test } from 'bun:test'
import {
  buildLineRuns,
  computeGeometry,
  toplineForY,
  clampCursorLine,
  runsForRows,
  rowForLine,
  lineForRow,
  LINE_PITCH
} from '../src/renderer/src/lib/minimap'

describe('buildLineRuns', () => {
  test('one run per non-whitespace chunk, columns from line start', () => {
    const runs = buildLineRuns(['  foo bar'], '#fff')
    expect(runs[0]).toEqual([
      { fromCol: 2, toCol: 5, color: '#fff' },
      { fromCol: 6, toCol: 9, color: '#fff' }
    ])
  })

  test('blank line yields no runs', () => {
    expect(buildLineRuns(['   '], '#fff')[0]).toEqual([])
  })

  test('caps columns at MAX_COLS', () => {
    const long = 'x'.repeat(200)
    const runs = buildLineRuns([long], '#fff')
    expect(runs[0][0].toCol).toBe(120)
  })
})

describe('computeGeometry', () => {
  test('indicator covers the visible line span', () => {
    const geo = computeGeometry(100, 1, 20, 1000)
    expect(geo.contentHeight).toBe(100 * LINE_PITCH)
    expect(geo.indicatorTop).toBe(0)
    expect(geo.indicatorHeight).toBe(20 * LINE_PITCH)
  })

  test('scrolled view slides the indicator down', () => {
    const geo = computeGeometry(100, 41, 60, 1000)
    // topline 41 → (41-1)*pitch above the fold (content fits, no map scroll).
    expect(geo.mapScrollTop).toBe(0)
    expect(geo.indicatorTop).toBe(40 * LINE_PITCH)
  })

  test('content taller than canvas slides the map proportionally', () => {
    const total = 1000
    const canvasHeight = 300
    const geo = computeGeometry(total, 501, 520, canvasHeight)
    expect(geo.contentHeight).toBe(total * LINE_PITCH)
    expect(geo.mapScrollTop).toBeGreaterThan(0)
  })
})

describe('toplineForY', () => {
  test('maps canvas y back to a 1-based line, clamped', () => {
    expect(toplineForY(0, 0, 100)).toBe(1)
    expect(toplineForY(30, 0, 100)).toBe(11)
    expect(toplineForY(99999, 0, 100)).toBe(100)
  })
})

describe('clampCursorLine', () => {
  test('pulls the cursor into the viewport', () => {
    expect(clampCursorLine(5, 40, 20, 100)).toBe(40)
    expect(clampCursorLine(80, 40, 20, 100)).toBe(59)
    expect(clampCursorLine(45, 40, 20, 100)).toBe(45)
  })
})

describe('diff-mode rows', () => {
  // Line 1, a filler row, line 2, a fold hiding lines 3–9, line 10.
  const rows = [1, 0, 2, -3, 10]

  test('runsForRows keeps line runs, flattens folds, empties fillers', () => {
    const run = (color: string) => [{ fromCol: 0, toCol: 4, color }]
    const lines = Array.from({ length: 10 }, (_, index) => run(`#${index + 1}`))
    const out = runsForRows(lines, rows, '#fold')
    expect(out[0]).toEqual(run('#1'))
    expect(out[1]).toEqual([])
    expect(out[2]).toEqual(run('#2'))
    expect(out[3][0].color).toBe('#fold')
    expect(out[4]).toEqual(run('#10'))
    expect(runsForRows(lines, rows, null)[3]).toEqual([])
  })

  test('rowForLine finds a line, or the fold hiding it', () => {
    expect(rowForLine(rows, 1)).toBe(1)
    expect(rowForLine(rows, 2)).toBe(3)
    expect(rowForLine(rows, 5)).toBe(4)
    expect(rowForLine(rows, 10)).toBe(5)
  })

  test('lineForRow maps fillers to the line below and folds to their start', () => {
    expect(lineForRow(rows, 2)).toBe(2)
    expect(lineForRow(rows, 4)).toBe(3)
    expect(lineForRow(rows, 5)).toBe(10)
    expect(lineForRow([1, 2, 0], 3)).toBe(2)
  })
})
