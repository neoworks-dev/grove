import { describe, it, expect } from 'bun:test'
import { colorForCapture } from '../src/renderer/src/lib/treesitterColors'
import type { ThemePalette } from '../src/renderer/src/lib/themes'

// Minimal palette stub — only the fields colorForCapture reads.
const palette = {
  ctxViolet: 'violet',
  ctxGreen: 'green',
  ctxAmber: 'amber',
  ctxBlue: 'blue',
  text: 'text',
  textMuted: 'muted',
  textDim: 'dim'
} as unknown as ThemePalette

describe('colorForCapture', () => {
  it('maps common capture families to theme colors', () => {
    expect(colorForCapture('keyword.control', palette)).toBe('violet')
    expect(colorForCapture('string', palette)).toBe('green')
    expect(colorForCapture('number', palette)).toBe('amber')
    expect(colorForCapture('function.builtin', palette)).toBe('blue')
    expect(colorForCapture('type', palette)).toBe('blue')
    expect(colorForCapture('property', palette)).toBe('blue')
    expect(colorForCapture('comment', palette)).toBe('dim')
    expect(colorForCapture('variable', palette)).toBe('text')
    expect(colorForCapture('operator', palette)).toBe('muted')
  })

  it('handles builtin sub-captures specially', () => {
    expect(colorForCapture('variable.builtin', palette)).toBe('amber')
    expect(colorForCapture('constant.builtin', palette)).toBe('amber')
  })

  it('returns null for unknown captures', () => {
    expect(colorForCapture('something.weird', palette)).toBeNull()
  })
})
