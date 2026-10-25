import { describe, expect, test } from 'bun:test'
import { dragPath, keysymChord } from '../scripts/qa/input.ts'

describe('keysymChord', () => {
  test('takes the Playwright spelling the harness has always taken', () => {
    expect(keysymChord('Control+s')).toBe('ctrl+s')
    expect(keysymChord('Shift+Tab')).toBe('shift+Tab')
    expect(keysymChord('Meta+Shift+p')).toBe('super+shift+p')
    expect(keysymChord('ArrowDown')).toBe('Down')
    expect(keysymChord('Enter')).toBe('Return')
    expect(keysymChord('Backspace')).toBe('BackSpace')
    expect(keysymChord('PageDown')).toBe('Next')
    expect(keysymChord('f2')).toBe('F2')
  })

  test('leaves letters alone, so a capital still means shift', () => {
    expect(keysymChord('g')).toBe('g')
    expect(keysymChord('G')).toBe('G')
  })

  test('names punctuation by its keysym', () => {
    expect(keysymChord('?')).toBe('question')
    expect(keysymChord(':')).toBe('colon')
    expect(keysymChord('Control+/')).toBe('ctrl+slash')
    expect(keysymChord('Control+\\')).toBe('ctrl+backslash')
  })

  test('reads a trailing plus as the plus key, not a separator', () => {
    expect(keysymChord('+')).toBe('plus')
    expect(keysymChord('Control++')).toBe('ctrl+plus')
  })
})

describe('dragPath', () => {
  test('moves in even steps and ends exactly on the target', () => {
    const path = dragPath({ x: 100, y: 500 }, { x: 400, y: 500 }, 3)
    expect(path).toEqual([
      { x: 200, y: 500 },
      { x: 300, y: 500 },
      { x: 400, y: 500 }
    ])
  })

  test('never starts with the press point, which is where the button went down', () => {
    const path = dragPath({ x: 10, y: 10 }, { x: 10, y: 70 })
    expect(path[0]).not.toEqual({ x: 10, y: 10 })
    expect(path[path.length - 1]).toEqual({ x: 10, y: 70 })
  })
})
