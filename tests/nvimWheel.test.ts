import { describe, expect, test } from 'bun:test'
import { WheelAccumulator } from '../src/renderer/src/lib/nvim/wheel'

const LINE = 20
const PAGE = 800

describe('WheelAccumulator', () => {
  test('small pixel deltas add up to whole lines', () => {
    const wheel = new WheelAccumulator()
    expect(wheel.lines(8, 0, LINE, PAGE)).toBe(0)
    expect(wheel.lines(8, 0, LINE, PAGE)).toBe(0)
    expect(wheel.lines(8, 0, LINE, PAGE)).toBe(1)
    expect(wheel.lines(16, 0, LINE, PAGE)).toBe(1)
  })

  test('a reversal drops the leftover from the old direction', () => {
    const wheel = new WheelAccumulator()
    expect(wheel.lines(15, 0, LINE, PAGE)).toBe(0)
    expect(wheel.lines(-15, 0, LINE, PAGE)).toBe(0)
    expect(wheel.lines(-10, 0, LINE, PAGE)).toBe(-1)
  })

  test('line and page deltas are converted', () => {
    const wheel = new WheelAccumulator()
    expect(wheel.lines(3, 1, LINE, PAGE)).toBe(3)
    expect(wheel.lines(1, 2, LINE, PAGE)).toBe(40)
  })

  test('a single event is capped', () => {
    const wheel = new WheelAccumulator()
    expect(wheel.lines(100_000, 0, LINE, PAGE)).toBe(60)
  })
})
