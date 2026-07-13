import { describe, expect, test } from 'bun:test'
import { createGridState } from '../src/renderer/src/lib/nvim/types'
import { defineHighlight, resolveColors, rgbToCss } from '../src/renderer/src/lib/nvim/highlights'

describe('highlights', () => {
  test('rgbToCss pads to six digits', () => {
    expect(rgbToCss(0xff0000)).toBe('#ff0000')
    expect(rgbToCss(0x000abc)).toBe('#000abc')
    expect(rgbToCss(0)).toBe('#000000')
  })

  test('unknown hl id falls back to defaults', () => {
    const state = createGridState()
    state.defaults = { fg: 0x111111, bg: 0x222222, sp: 0x333333 }
    expect(resolveColors(state, 42)).toEqual({ fg: '#111111', bg: '#222222', sp: '#333333' })
  })

  test('defined attrs override defaults, missing fields fall through', () => {
    const state = createGridState()
    state.defaults = { fg: 0x111111, bg: 0x222222, sp: 0x333333 }
    defineHighlight(state, 1, { foreground: 0xabcdef, bold: true })
    const colors = resolveColors(state, 1)
    expect(colors.fg).toBe('#abcdef')
    expect(colors.bg).toBe('#222222')
  })

  test('reverse swaps fg and bg after defaults resolve', () => {
    const state = createGridState()
    state.defaults = { fg: 0x111111, bg: 0x222222, sp: 0x333333 }
    defineHighlight(state, 2, { reverse: true })
    const colors = resolveColors(state, 2)
    expect(colors.fg).toBe('#222222')
    expect(colors.bg).toBe('#111111')
  })
})
