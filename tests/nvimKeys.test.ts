import { describe, expect, test } from 'bun:test'
import { encodeKeyEvent, type KeyEventLike } from '../src/renderer/src/lib/nvim/keys'

function key(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...partial }
}

describe('encodeKeyEvent', () => {
  test('printables pass through, shift already baked in', () => {
    expect(encodeKeyEvent(key({ key: 'a' }))).toBe('a')
    expect(encodeKeyEvent(key({ key: 'A', shiftKey: true }))).toBe('A')
    expect(encodeKeyEvent(key({ key: '$', shiftKey: true }))).toBe('$')
  })

  test('< becomes <lt>', () => {
    expect(encodeKeyEvent(key({ key: '<', shiftKey: true }))).toBe('<lt>')
  })

  test('special keys map to vim names', () => {
    expect(encodeKeyEvent(key({ key: 'Escape' }))).toBe('<Esc>')
    expect(encodeKeyEvent(key({ key: 'Enter' }))).toBe('<CR>')
    expect(encodeKeyEvent(key({ key: 'Backspace' }))).toBe('<BS>')
    expect(encodeKeyEvent(key({ key: 'ArrowLeft' }))).toBe('<Left>')
    expect(encodeKeyEvent(key({ key: 'F5' }))).toBe('<F5>')
  })

  test('modifier chords', () => {
    expect(encodeKeyEvent(key({ key: 'a', ctrlKey: true }))).toBe('<C-a>')
    expect(encodeKeyEvent(key({ key: 'Tab', shiftKey: true }))).toBe('<S-Tab>')
    expect(encodeKeyEvent(key({ key: 'x', altKey: true }))).toBe('<A-x>')
    expect(encodeKeyEvent(key({ key: 'p', metaKey: true }))).toBe('<D-p>')
    expect(encodeKeyEvent(key({ key: 'r', ctrlKey: true, altKey: true }))).toBe('<C-A-r>')
  })

  test('ctrl+space and modified <', () => {
    expect(encodeKeyEvent(key({ key: ' ', ctrlKey: true }))).toBe('<C-Space>')
    expect(encodeKeyEvent(key({ key: '<', ctrlKey: true }))).toBe('<C-lt>')
  })

  test('no shift modifier added to printables in chords', () => {
    expect(encodeKeyEvent(key({ key: 'A', ctrlKey: true, shiftKey: true }))).toBe('<C-A>')
  })

  test('AltGr heuristic: ctrl+alt with non-letter char sends raw char', () => {
    expect(encodeKeyEvent(key({ key: '@', ctrlKey: true, altKey: true }))).toBe('@')
    expect(encodeKeyEvent(key({ key: '{', ctrlKey: true, altKey: true }))).toBe('{')
  })

  test('null for modifiers, dead keys, and composition', () => {
    expect(encodeKeyEvent(key({ key: 'Shift', shiftKey: true }))).toBeNull()
    expect(encodeKeyEvent(key({ key: 'Control', ctrlKey: true }))).toBeNull()
    expect(encodeKeyEvent(key({ key: 'Dead' }))).toBeNull()
    expect(encodeKeyEvent(key({ key: 'Unidentified' }))).toBeNull()
    expect(encodeKeyEvent(key({ key: 'a', isComposing: true }))).toBeNull()
  })

  test('non-printable non-special keys are not forwarded', () => {
    expect(encodeKeyEvent(key({ key: 'MediaPlayPause' }))).toBeNull()
  })
})
