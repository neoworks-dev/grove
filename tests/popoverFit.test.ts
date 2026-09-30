import { describe, expect, test } from 'bun:test'
import { horizontalShift } from '../src/renderer/src/lib/popoverFit'

describe('horizontalShift', () => {
  const boundary = { left: 960, right: 1420 }

  test('leaves a popover that fits where it is', () => {
    expect(horizontalShift({ left: 960, right: 1216 }, boundary)).toBe(0)
  })

  test('moves one that runs off the right edge back inside', () => {
    // The agent mode menu, opened from a control that wrapped to the right.
    expect(horizontalShift({ left: 1245, right: 1501 }, boundary)).toBe(-81)
  })

  test('keeps the left edge inside when the popover is wider than the boundary', () => {
    expect(horizontalShift({ left: 1000, right: 1500 }, { left: 980, right: 1300 })).toBe(-20)
  })
})
