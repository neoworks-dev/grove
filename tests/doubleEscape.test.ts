import { describe, expect, test } from 'bun:test'
import { DOUBLE_ESCAPE_MS, DoubleEscape, escapeAction } from '../src/renderer/src/lib/agents/doubleEscape'

describe('DoubleEscape', () => {
  test('a second press inside the window is a double press', () => {
    const escape = new DoubleEscape()
    expect(escape.press(1000)).toBe(false)
    expect(escape.press(1000 + DOUBLE_ESCAPE_MS)).toBe(true)
  })

  test('a slow second press starts over', () => {
    const escape = new DoubleEscape()
    escape.press(1000)
    expect(escape.press(1000 + DOUBLE_ESCAPE_MS + 1)).toBe(false)
  })

  test('a third press is not part of the first double', () => {
    const escape = new DoubleEscape()
    escape.press(1000)
    escape.press(1100)
    expect(escape.press(1200)).toBe(false)
  })
})

describe('escapeAction', () => {
  test('one Escape interrupts a running turn and does nothing when idle', () => {
    expect(escapeAction({ running: true, hasDraft: true, doublePress: false })).toBe('interrupt')
    expect(escapeAction({ running: false, hasDraft: true, doublePress: false })).toBe('none')
  })

  test('a double Escape clears a draft', () => {
    expect(escapeAction({ running: false, hasDraft: true, doublePress: true })).toBe('clear')
    expect(escapeAction({ running: true, hasDraft: true, doublePress: true })).toBe('clear')
  })

  test('a double Escape on an empty idle prompt opens rewind', () => {
    expect(escapeAction({ running: false, hasDraft: false, doublePress: true })).toBe('rewind')
  })

  test('a double Escape on an empty running prompt keeps interrupting', () => {
    expect(escapeAction({ running: true, hasDraft: false, doublePress: true })).toBe('interrupt')
  })
})
