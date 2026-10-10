// The hints under the prompt name the keys that are bound now, and appear only
// while they matter; the context warning appears from the line it is set at.

import { describe, expect, test } from 'bun:test'
import {
  contextIsLow,
  contextLowMessage,
  footerHintsOf
} from '../src/renderer/src/lib/agents/footerHints'

const idle = {
  running: false,
  commandRunning: false,
  cycleModeKeys: ['⇧Tab'],
  backgroundKeys: ['Ctrl+b']
}

describe('footerHintsOf', () => {
  test('an idle session only hints at cycling the mode', () => {
    expect(footerHintsOf(idle)).toEqual([{ keys: '⇧Tab', text: 'cycle mode' }])
  })

  test('a running turn adds the interrupt key and a running command the background key', () => {
    const hints = footerHintsOf({ ...idle, running: true, commandRunning: true })
    expect(hints.map((hint) => hint.keys)).toEqual(['⇧Tab', 'Esc', 'Ctrl+b'])
  })

  test('a rebound key is named, and an unbound one is left out', () => {
    const hints = footerHintsOf({
      ...idle,
      commandRunning: true,
      cycleModeKeys: ['Ctrl+m'],
      backgroundKeys: []
    })
    expect(hints).toEqual([{ keys: 'Ctrl+m', text: 'cycle mode' }])
  })
})

describe('context warning', () => {
  test('appears at 85 percent used and says what is left', () => {
    expect(contextIsLow(0.84)).toBe(false)
    expect(contextIsLow(0.85)).toBe(true)
    expect(contextLowMessage(0.92)).toContain('8% left')
  })
})
