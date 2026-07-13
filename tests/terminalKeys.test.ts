import { describe, expect, test } from 'bun:test'
import { createTerminalEscapeHandler } from '../src/renderer/src/lib/terminalKeys'

function keydown(key: string, ctrlKey = true): { type: string; key: string; ctrlKey: boolean } {
  return { type: 'keydown', key, ctrlKey }
}

describe('createTerminalEscapeHandler', () => {
  test('ctrl+\\ ctrl+n escapes and swallows both keys', () => {
    let escaped = false
    const handle = createTerminalEscapeHandler(() => {
      escaped = true
    })
    expect(handle(keydown('\\'))).toBe(false)
    expect(handle(keydown('n'))).toBe(false)
    expect(escaped).toBe(true)
  })

  test('other key after ctrl+\\ cancels the pending escape', () => {
    let escaped = false
    const handle = createTerminalEscapeHandler(() => {
      escaped = true
    })
    expect(handle(keydown('\\'))).toBe(false)
    expect(handle(keydown('a', false))).toBe(true)
    expect(handle(keydown('n'))).toBe(true)
    expect(escaped).toBe(false)
  })

  test('ctrl+n without pending escape passes through', () => {
    let escaped = false
    const handle = createTerminalEscapeHandler(() => {
      escaped = true
    })
    expect(handle(keydown('n'))).toBe(true)
    expect(escaped).toBe(false)
  })

  test('keyup events never affect pending state', () => {
    let escaped = false
    const handle = createTerminalEscapeHandler(() => {
      escaped = true
    })
    expect(handle(keydown('\\'))).toBe(false)
    expect(handle({ type: 'keyup', key: '\\', ctrlKey: true })).toBe(true)
    expect(handle(keydown('n'))).toBe(false)
    expect(escaped).toBe(true)
  })
})
