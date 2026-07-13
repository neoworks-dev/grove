import { describe, it, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import {
  computeGeometry,
  extractLineRuns,
  LINE_PITCH,
  MAX_COLS
} from '../src/renderer/src/lib/minimap'
import type { ThemePalette } from '../src/renderer/src/lib/themes'

// Minimal palette stub — only the fields the minimap extraction reads.
const palette = {
  bg: 'bg',
  text: 'text',
  textMuted: 'muted',
  textDim: 'dim',
  ctxViolet: 'violet',
  ctxGreen: 'green',
  ctxAmber: 'amber',
  ctxBlue: 'blue',
  ctxRed: 'red'
} as unknown as ThemePalette

describe('computeGeometry', () => {
  it('keeps the map static when it fits the canvas', () => {
    const geometry = computeGeometry(100, 600, 500, 2000, 1000)
    expect(geometry.contentHeight).toBe(100 * LINE_PITCH)
    expect(geometry.mapScrollTop).toBe(0)
    expect(geometry.indicatorTop).toBeCloseTo((500 / 2000) * 300)
    expect(geometry.indicatorHeight).toBeCloseTo((1000 / 2000) * 300)
  })

  it('slides the map proportionally when taller than the canvas', () => {
    // 1000 lines * 3px = 3000px map in a 600px canvas; scrolled halfway.
    const geometry = computeGeometry(1000, 600, 5000, 11000, 1000)
    expect(geometry.mapScrollTop).toBeCloseTo((3000 - 600) * 0.5)
    // Indicator stays inside the canvas at half scroll.
    expect(geometry.indicatorTop).toBeGreaterThan(0)
    expect(geometry.indicatorTop + geometry.indicatorHeight).toBeLessThanOrEqual(600)
  })

  it('pins the indicator to the edges at scroll extremes', () => {
    const top = computeGeometry(1000, 600, 0, 11000, 1000)
    expect(top.indicatorTop).toBe(0)
    const bottom = computeGeometry(1000, 600, 10000, 11000, 1000)
    expect(bottom.indicatorTop + bottom.indicatorHeight).toBeCloseTo(600)
  })

  it('handles a non-scrollable document without dividing by zero', () => {
    const geometry = computeGeometry(10, 600, 0, 500, 500)
    expect(geometry.mapScrollTop).toBe(0)
    expect(geometry.indicatorTop).toBe(0)
    expect(Number.isFinite(geometry.indicatorHeight)).toBe(true)
  })
})

describe('extractLineRuns', () => {
  it('falls back to monochrome shape runs without a syntax tree', () => {
    const state = EditorState.create({ doc: '  indented text\n\nplain' })
    const runs = extractLineRuns(state, palette)
    expect(runs.length).toBe(3)
    expect(runs[0]).toEqual([{ fromCol: 2, toCol: 15, color: 'muted' }])
    expect(runs[1]).toEqual([])
    expect(runs[2]).toEqual([{ fromCol: 0, toCol: 5, color: 'muted' }])
  })

  it('caps monochrome runs at MAX_COLS', () => {
    const state = EditorState.create({ doc: 'x'.repeat(500) })
    const runs = extractLineRuns(state, palette)
    expect(runs[0][0].toCol).toBe(MAX_COLS)
  })

  it('colors tokens via the shared theme specs when a Lezer tree exists', () => {
    const state = EditorState.create({
      doc: 'const answer = 42 // note\n',
      extensions: [javascript()]
    })
    const runs = extractLineRuns(state, palette)
    const colors = runs[0].map((run) => run.color)
    expect(colors).toContain('violet') // const → keyword
    expect(colors).toContain('amber') // 42 → number
    expect(colors).toContain('dim') // comment
    // Runs never overlap and stay ordered.
    for (let i = 1; i < runs[0].length; i++) {
      expect(runs[0][i].fromCol).toBeGreaterThanOrEqual(runs[0][i - 1].toCol)
    }
  })
})
