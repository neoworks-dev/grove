import { expect, test } from 'bun:test'
import {
  isAboutPreview,
  parsePreview,
  placePopover,
  withFixes
} from '../src/renderer/src/lib/nvim/previews'

const diagnosticsPayload = {
  id: 2,
  kind: 'diagnostics',
  row: 1,
  col: 0,
  diagnostics: [{ severity: 2, message: 'unused', source: 'ts', code: '6133' }, { severity: 1 }]
}

test('a doc preview keeps its blocks, styled runs and theme', () => {
  const preview = parsePreview({
    id: 3,
    kind: 'doc',
    row: 4,
    col: 10,
    theme: { fg: '#e4e4e7', bg: '#27272a', raw: 'not a colour' },
    blocks: [
      { kind: 'code', lines: [[{ text: 'const', fg: '#c084fc', bold: true }, { text: ' a' }], []] },
      { kind: 'markdown', text: 'Returns **a**.' },
      { kind: 'markdown', text: '  \n' }
    ]
  })
  expect(preview).toEqual({
    id: 3,
    kind: 'doc',
    row: 4,
    col: 10,
    theme: { fg: '#e4e4e7', bg: '#27272a' },
    blocks: [
      {
        kind: 'code',
        lines: [
          [
            { text: 'const', fg: '#c084fc', bold: true, italic: false, underline: false },
            { text: ' a', bold: false, italic: false, underline: false }
          ],
          []
        ]
      },
      { kind: 'markdown', text: 'Returns **a**.' }
    ]
  })
})

test('a preview without an anchor or content is not shown', () => {
  expect(parsePreview({ id: 1, kind: 'doc', blocks: [{ kind: 'text', text: 'hi' }] })).toBeNull()
  expect(parsePreview({ id: 1, kind: 'doc', row: 0, col: 0, blocks: [{ kind: 'text', text: ' ' }] })).toBeNull()
  expect(parsePreview({ id: 1, kind: 'diagnostics', diagnostics: [], row: 0, col: 0 })).toBeNull()
})

test('diagnostics start without fixes and drop malformed entries', () => {
  expect(parsePreview(diagnosticsPayload)).toEqual({
    id: 2,
    kind: 'diagnostics',
    row: 1,
    col: 0,
    theme: {},
    diagnostics: [{ severity: 2, message: 'unused', source: 'ts', code: '6133' }],
    fixes: null
  })
})

test('fixes land only on the preview they were asked for', () => {
  const preview = parsePreview(diagnosticsPayload)
  if (preview === null) throw new Error('expected a preview')
  expect(withFixes(preview, { id: 1, fixes: ['stale'] })).toBe(preview)
  const fixed = withFixes(preview, { id: 2, fixes: ['Remove unused import', 7] })
  expect(fixed.kind === 'diagnostics' && fixed.fixes).toEqual(['Remove unused import'])
})

test('a close or focus for another preview leaves this one alone', () => {
  const preview = parsePreview(diagnosticsPayload)
  if (preview === null) throw new Error('expected a preview')
  expect(isAboutPreview(preview, { id: 1 })).toBe(false)
  expect(isAboutPreview(preview, { id: 2 })).toBe(true)
})

test('the popover sits below the line, above it when only above has room', () => {
  const pane = { width: 800, height: 400 }
  const popover = { width: 300, height: 120 }
  expect(placePopover({ left: 100, top: 40, lineHeight: 20 }, popover, pane, 4)).toEqual({
    left: 100,
    top: 64,
    above: false
  })
  expect(placePopover({ left: 100, top: 340, lineHeight: 20 }, popover, pane, 4)).toEqual({
    left: 100,
    top: 216,
    above: true
  })
})

test('the popover shifts left to stay inside the pane', () => {
  const placement = placePopover(
    { left: 700, top: 40, lineHeight: 20 },
    { width: 300, height: 100 },
    { width: 800, height: 400 },
    4
  )
  expect(placement.left).toBe(500)
})
