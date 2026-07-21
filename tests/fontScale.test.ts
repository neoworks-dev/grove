import { describe, it, expect } from 'bun:test'
import {
  clampFontScale,
  steppedFontScale,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  FONT_SCALE_DEFAULT
} from '../src/renderer/src/lib/fontScale'

describe('clampFontScale', () => {
  it('keeps in-range values, snapped to the step grid', () => {
    expect(clampFontScale(1)).toBe(1)
    expect(clampFontScale(1.5)).toBe(1.5)
    expect(clampFontScale(0.83)).toBe(0.8)
  })

  it('clamps below the minimum and above the maximum', () => {
    expect(clampFontScale(0.1)).toBe(FONT_SCALE_MIN)
    expect(clampFontScale(-5)).toBe(FONT_SCALE_MIN)
    expect(clampFontScale(10)).toBe(FONT_SCALE_MAX)
  })
})

describe('steppedFontScale', () => {
  it('steps up and down by one tenth without float drift', () => {
    expect(steppedFontScale(1, 1)).toBe(1.1)
    expect(steppedFontScale(1, -1)).toBe(0.9)
    // 1.2 - 0.1 must be exactly 1.1, not 1.0999999999999999.
    expect(steppedFontScale(1.2, -1)).toBe(1.1)
  })

  it('never steps past the bounds', () => {
    expect(steppedFontScale(FONT_SCALE_MAX, 1)).toBe(FONT_SCALE_MAX)
    expect(steppedFontScale(FONT_SCALE_MIN, -1)).toBe(FONT_SCALE_MIN)
  })

  it('returns to the default after inverse steps', () => {
    const up = steppedFontScale(FONT_SCALE_DEFAULT, 1)
    expect(steppedFontScale(up, -1)).toBe(FONT_SCALE_DEFAULT)
  })
})
