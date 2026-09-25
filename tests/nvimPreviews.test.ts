import { expect, test } from 'bun:test'
import {
  closesPreview,
  parsePreview,
  placePopover,
  withFixes
} from '../src/renderer/src/lib/nvim/previews'

test('a markdown preview keeps its text and anchor', () => {
  expect(parsePreview({ id: 3, kind: 'markdown', text: '```ts\nconst a\n```', row: 4, col: 10 })).toEqual({
    id: 3,
    kind: 'markdown',
    text: '```ts\nconst a\n```',
    row: 4,
    col: 10
  })
})

test('an empty or anchorless preview is not shown', () => {
  expect(parsePreview({ id: 1, kind: 'text', text: '  \n', row: 0, col: 0 })).toBeNull()
  expect(parsePreview({ id: 1, kind: 'text', text: 'hi' })).toBeNull()
})

test('diagnostics start without fixes and drop malformed entries', () => {
  const preview = parsePreview({
    id: 2,
    kind: 'diagnostics',
    row: 1,
    col: 0,
    diagnostics: [{ severity: 2, message: 'unused', source: 'ts', code: '6133' }, { severity: 1 }]
  })
  expect(preview).toEqual({
    id: 2,
    kind: 'diagnostics',
    row: 1,
    col: 0,
    diagnostics: [{ severity: 2, message: 'unused', source: 'ts', code: '6133' }],
    fixes: null
  })
})

test('fixes land only on the preview they were asked for', () => {
  const preview = parsePreview({
    id: 2,
    kind: 'diagnostics',
    row: 1,
    col: 0,
    diagnostics: [{ severity: 1, message: 'x' }]
  })
  if (preview === null) throw new Error('expected a preview')
  expect(withFixes(preview, { id: 1, fixes: ['stale'] })).toBe(preview)
  const fixed = withFixes(preview, { id: 2, fixes: ['Remove unused import', 7] })
  expect(fixed.kind === 'diagnostics' && fixed.fixes).toEqual(['Remove unused import'])
})

test('a close for another preview leaves this one open', () => {
  const preview = parsePreview({ id: 5, kind: 'text', text: 'hi', row: 0, col: 0 })
  if (preview === null) throw new Error('expected a preview')
  expect(closesPreview(preview, { id: 4 })).toBe(false)
  expect(closesPreview(preview, { id: 5 })).toBe(true)
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
