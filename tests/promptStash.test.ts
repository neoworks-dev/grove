// The composer's Ctrl+S stash: which keystrokes count, and that one draft is held at a time.

import { describe, expect, test } from 'bun:test'
import { isStashKey, PromptStash } from '../src/renderer/src/lib/agents/promptStash'

const UNPRESSED = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }

/** A keystroke with the given key and modifiers pressed, all others unpressed. */
function keystroke(
  key: string,
  modifiers: Partial<typeof UNPRESSED> = {}
): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'> {
  return { key, ...UNPRESSED, ...modifiers }
}

describe('isStashKey', () => {
  test('matches Ctrl+S alone', () => {
    expect(isStashKey(keystroke('s', { ctrlKey: true }))).toBe(true)
    expect(isStashKey(keystroke('S', { ctrlKey: true }))).toBe(true)
  })

  test('ignores plain S and Ctrl+S with another modifier', () => {
    expect(isStashKey(keystroke('s'))).toBe(false)
    expect(isStashKey(keystroke('s', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isStashKey(keystroke('s', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(isStashKey(keystroke('s', { ctrlKey: true, metaKey: true }))).toBe(false)
  })

  test('ignores other keys with Ctrl', () => {
    expect(isStashKey(keystroke('d', { ctrlKey: true }))).toBe(false)
  })
})

describe('PromptStash', () => {
  test('holds nothing until a draft is put', () => {
    const stash = new PromptStash<string>()
    expect(stash.take()).toBeNull()
  })

  test('takes the held draft out once', () => {
    const stash = new PromptStash<string>()
    stash.put('half a thought')
    expect(stash.take()).toBe('half a thought')
    expect(stash.take()).toBeNull()
  })

  test('putting again hands back the draft it displaces', () => {
    const stash = new PromptStash<string>()
    expect(stash.put('first')).toBeNull()
    expect(stash.put('second')).toBe('first')
    expect(stash.take()).toBe('second')
  })
})
