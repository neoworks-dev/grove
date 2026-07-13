// Minimap rendering data. Pure functions that turn an EditorState into
// per-line colored runs (via the same tag→color table as the editor theme)
// and compute the scroll geometry for the minimap canvas. Kept free of DOM
// so the math is unit-testable.

import type { EditorState, Text, Line } from '@codemirror/state'
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language'
import { highlightTree, tagHighlighter, type Highlighter } from '@lezer/highlight'
import { tokenColorSpecs } from './editor'
import type { ThemePalette } from './themes'

// A horizontal stretch of one line drawn in a single color. Columns are
// character offsets from the line start, capped at MAX_COLS.
export interface LineRun {
  fromCol: number
  toCol: number
  color: string
}

export interface MinimapGeometry {
  // Total height of the rendered map in CSS px (lines * LINE_PITCH).
  contentHeight: number
  // How far the map content is slid up when taller than the canvas
  // (VSCode-style proportional slider).
  mapScrollTop: number
  indicatorTop: number
  indicatorHeight: number
}

export const LINE_PITCH = 3
export const GLYPH_HEIGHT = 2
export const COL_WIDTH = 0.6
export const MAX_COLS = 120

// Above this the file is too big to walk the highlight tree per keystroke;
// fall back to monochrome shape runs.
const MAX_HIGHLIGHT_LINES = 60_000
// Time budget for forcing the parse forward on freshly opened files (ms).
const PARSE_BUDGET_MS = 50

export function computeGeometry(
  lines: number,
  canvasHeight: number,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number
): MinimapGeometry {
  const contentHeight = lines * LINE_PITCH
  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  const scrollRatio = maxScroll > 0 ? scrollTop / maxScroll : 0
  const mapScrollTop = Math.max(0, contentHeight - canvasHeight) * scrollRatio
  const indicatorHeight = Math.min(
    canvasHeight,
    (clientHeight / Math.max(1, scrollHeight)) * contentHeight
  )
  const indicatorTop = (scrollTop / Math.max(1, scrollHeight)) * contentHeight - mapScrollTop
  return { contentHeight, mapScrollTop, indicatorTop, indicatorHeight }
}

// The highlighter used to color minimap runs: same specs as the editor's
// HighlightStyle, but style() yields the color string itself so highlightTree
// hands colors straight to the callback (no class→color reverse mapping).
export function minimapHighlighter(palette: ThemePalette): Highlighter {
  const colored = tokenColorSpecs(palette).filter((spec) => spec.color !== undefined)
  return tagHighlighter(colored.map((spec) => ({ tag: spec.tag, class: spec.color as string })))
}

export function extractLineRuns(state: EditorState, palette: ThemePalette): LineRun[][] {
  const doc = state.doc
  const runs: LineRun[][] = []
  for (let i = 0; i < doc.lines; i++) runs.push([])

  if (doc.lines > MAX_HIGHLIGHT_LINES) {
    fillMonochromeRuns(runs, doc, palette.textMuted)
    return runs
  }
  const tree = ensureSyntaxTree(state, doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state)
  if (tree.length === 0) {
    // Tree-sitter-highlighted or plain-text buffers have no Lezer tree.
    fillMonochromeRuns(runs, doc, palette.textMuted)
    return runs
  }

  let cursor = 0
  highlightTree(tree, minimapHighlighter(palette), (from, to, colors) => {
    if (from > cursor) addPlainRuns(runs, doc, cursor, from, palette.text)
    addColoredRuns(runs, doc, from, to, firstColor(colors))
    cursor = to
  })
  if (cursor < doc.length) addPlainRuns(runs, doc, cursor, doc.length, palette.text)
  return runs
}

// tagHighlighter joins classes with spaces when several specs match; the
// first (most specific) one wins for the minimap.
function firstColor(colors: string): string {
  const spaceIndex = colors.indexOf(' ')
  if (spaceIndex === -1) return colors
  return colors.slice(0, spaceIndex)
}

type LineSegmentCallback = (line: Line, segmentFrom: number, segmentTo: number) => void

function forEachLineSegment(
  doc: Text,
  from: number,
  to: number,
  callback: LineSegmentCallback
): void {
  let line = doc.lineAt(from)
  while (true) {
    const segmentFrom = Math.max(from, line.from)
    const segmentTo = Math.min(to, line.to)
    if (segmentTo > segmentFrom) callback(line, segmentFrom, segmentTo)
    if (line.to >= to || line.number >= doc.lines) return
    line = doc.line(line.number + 1)
  }
}

function addColoredRuns(
  runs: LineRun[][],
  doc: Text,
  from: number,
  to: number,
  color: string
): void {
  forEachLineSegment(doc, from, to, (line, segmentFrom, segmentTo) => {
    const fromCol = segmentFrom - line.from
    if (fromCol >= MAX_COLS) return
    const toCol = Math.min(segmentTo - line.from, MAX_COLS)
    runs[line.number - 1].push({ fromCol, toCol, color })
  })
}

// Unhighlighted stretches: emit one run per non-whitespace chunk so the map
// keeps the shape of the text (indentation and gaps stay visible).
function addPlainRuns(runs: LineRun[][], doc: Text, from: number, to: number, color: string): void {
  forEachLineSegment(doc, from, to, (line, segmentFrom, segmentTo) => {
    const baseCol = segmentFrom - line.from
    if (baseCol >= MAX_COLS) return
    const cappedTo = Math.min(segmentTo, line.from + MAX_COLS)
    const text = doc.sliceString(segmentFrom, cappedTo)
    pushChunkRuns(runs[line.number - 1], text, baseCol, color)
  })
}

function pushChunkRuns(lineRuns: LineRun[], text: string, baseCol: number, color: string): void {
  const chunkPattern = /\S+/g
  let match = chunkPattern.exec(text)
  while (match !== null) {
    const fromCol = baseCol + match.index
    lineRuns.push({ fromCol, toCol: fromCol + match[0].length, color })
    match = chunkPattern.exec(text)
  }
}

// Fallback when no syntax tree is available: one run per line from the first
// to the last non-whitespace character, single color.
function fillMonochromeRuns(runs: LineRun[][], doc: Text, color: string): void {
  const iterator = doc.iterLines()
  let lineIndex = 0
  while (!iterator.next().done) {
    appendMonochromeRun(runs[lineIndex], iterator.value, color)
    lineIndex++
  }
}

function appendMonochromeRun(lineRuns: LineRun[], text: string, color: string): void {
  const capped = text.slice(0, MAX_COLS)
  const firstNonWhitespace = capped.search(/\S/)
  if (firstNonWhitespace === -1) return
  const trimmedLength = capped.replace(/\s+$/, '').length
  lineRuns.push({ fromCol: firstNonWhitespace, toCol: trimmedLength, color })
}
