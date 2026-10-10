import { describe, expect, test } from 'bun:test'
import {
  createVimState,
  handleVimKey,
  placeVimCursor,
  vimSelection,
  type VimInput,
  type VimState
} from '../src/renderer/src/lib/agents/composerVim'

const NAMED_KEYS: Record<string, string> = { '<Esc>': 'Escape', '<CR>': 'Enter', '<BS>': 'Backspace' }

/** A keystroke for a key name with no modifiers held. */
function inputFor(key: string): VimInput {
  return { key, ctrl: false, alt: false, meta: false, shift: false }
}

/** Splits "dw<Esc>x" into the keys it spells. */
function keysOf(sequence: string): string[] {
  const keys: string[] = []
  let index = 0
  while (index < sequence.length) {
    const named = Object.keys(NAMED_KEYS).find((name) => sequence.startsWith(name, index))
    if (named !== undefined) {
      keys.push(NAMED_KEYS[named])
      index += named.length
      continue
    }
    keys.push(sequence[index])
    index++
  }
  return keys
}

/**
 * Types keys at vim the way the composer does: keys it leaves unhandled in insert
 * mode are typed into the text at the cursor.
 */
function type(state: VimState, sequence: string): VimState {
  let current = state
  for (const key of keysOf(sequence)) {
    const result = handleVimKey(current, inputFor(key))
    current = result.state
    if (!result.handled && current.mode === 'insert' && key.length === 1) {
      const text = current.text.slice(0, current.cursor) + key + current.text.slice(current.cursor)
      current = { ...current, text, cursor: current.cursor + 1 }
    }
  }
  return current
}

/** A state in normal mode on `text` with the cursor at `cursor`. */
function normalAt(text: string, cursor: number): VimState {
  return placeVimCursor({ ...createVimState(text), mode: 'normal' }, text, cursor)
}

describe('modes', () => {
  test('starts in insert mode, where keys are left to the textarea', () => {
    const result = handleVimKey(createVimState(''), inputFor('a'))
    expect(result.handled).toBe(false)
    expect(result.state.mode).toBe('insert')
  })

  test('Escape leaves insert mode with the cursor on the last character typed', () => {
    const state = type(createVimState(''), 'abc<Esc>')
    expect(state.mode).toBe('normal')
    expect(state.cursor).toBe(2)
  })

  test('normal mode swallows letters instead of typing them', () => {
    const result = handleVimKey(normalAt('abc', 0), inputFor('z'))
    expect(result.handled).toBe(true)
    expect(result.state.text).toBe('abc')
  })

  test('Escape in normal mode is left for interrupting the agent', () => {
    expect(handleVimKey(normalAt('abc', 0), inputFor('Escape')).handled).toBe(false)
  })

  test('Enter sends in every mode, and Shift+Enter breaks the line in insert', () => {
    expect(handleVimKey(createVimState('hi'), inputFor('Enter')).send).toBe(true)
    expect(handleVimKey(normalAt('hi', 0), inputFor('Enter')).send).toBe(true)
    const shifted = handleVimKey(createVimState('hi'), { ...inputFor('Enter'), shift: true })
    expect(shifted.send).toBe(false)
    expect(shifted.handled).toBe(false)
  })

  test('chords with Ctrl, Alt or Meta are left alone, as are bare modifier keys', () => {
    const state = normalAt('abc', 0)
    expect(handleVimKey(state, { ...inputFor('r'), ctrl: true }).handled).toBe(false)
    expect(handleVimKey(state, inputFor('Shift')).handled).toBe(false)
  })
})

describe('inserting', () => {
  test('i, a, I and A start typing in the right place', () => {
    expect(type(normalAt('hello world', 6), 'iX').text).toBe('hello Xworld')
    expect(type(normalAt('hello world', 6), 'aX').text).toBe('hello wXorld')
    expect(type(normalAt('  hello', 4), 'IX').text).toBe('  Xhello')
    expect(type(normalAt('hello', 0), 'AX').text).toBe('helloX')
  })

  test('o and O open a line below and above', () => {
    expect(type(normalAt('one\ntwo', 1), 'oX').text).toBe('one\nX\ntwo')
    expect(type(normalAt('one\ntwo', 5), 'OX').text).toBe('one\nX\ntwo')
  })
})

describe('motions', () => {
  test('h, l, 0, $ and ^ move along the line without leaving it', () => {
    expect(type(normalAt('hello', 2), 'h').cursor).toBe(1)
    expect(type(normalAt('hello', 0), 'h').cursor).toBe(0)
    expect(type(normalAt('hello', 3), 'll').cursor).toBe(4)
    expect(type(normalAt('hello', 2), '$').cursor).toBe(4)
    expect(type(normalAt('hello', 2), '0').cursor).toBe(0)
    expect(type(normalAt('   hello', 5), '^').cursor).toBe(3)
  })

  test('j and k keep the column where the line is long enough', () => {
    expect(type(normalAt('abcd\nefgh', 2), 'j').cursor).toBe(7)
    expect(type(normalAt('abcd\nef', 3), 'j').cursor).toBe(6)
    expect(type(normalAt('abcd\nefgh', 7), 'k').cursor).toBe(2)
  })

  test('w, e and b step by word, taking punctuation as its own word', () => {
    const text = 'foo bar.baz qux'
    expect(type(normalAt(text, 0), 'w').cursor).toBe(4)
    expect(type(normalAt(text, 0), 'ww').cursor).toBe(7)
    expect(type(normalAt(text, 0), 'e').cursor).toBe(2)
    expect(type(normalAt(text, 2), 'e').cursor).toBe(6)
    expect(type(normalAt(text, 12), 'b').cursor).toBe(8)
    expect(type(normalAt(text, 4), 'b').cursor).toBe(0)
  })

  test('gg and G go to the first and last line', () => {
    expect(type(normalAt('one\ntwo\n three', 5), 'gg').cursor).toBe(0)
    expect(type(normalAt('one\ntwo\n three', 0), 'G').cursor).toBe(9)
  })

  test('f, F, t and T find a character on the line', () => {
    const text = 'a,b,c,d'
    expect(type(normalAt(text, 0), 'f,').cursor).toBe(1)
    expect(type(normalAt(text, 0), 'fc').cursor).toBe(4)
    expect(type(normalAt(text, 0), 'tc').cursor).toBe(3)
    expect(type(normalAt(text, 6), 'F,').cursor).toBe(5)
    expect(type(normalAt(text, 6), 'Tb').cursor).toBe(3)
  })

  test('a find that cannot land leaves the cursor, and does not cross lines', () => {
    expect(type(normalAt('abc\ndef', 0), 'fz').cursor).toBe(0)
    expect(type(normalAt('abc\ndef', 0), 'fd').cursor).toBe(0)
  })
})

describe('deleting', () => {
  test('x deletes the character under the cursor', () => {
    const state = type(normalAt('hello', 1), 'x')
    expect(state.text).toBe('hllo')
    expect(state.cursor).toBe(1)
  })

  test('x at the end of a line leaves the cursor on the new last character', () => {
    const state = type(normalAt('abc', 2), 'x')
    expect(state.text).toBe('ab')
    expect(state.cursor).toBe(1)
  })

  test('dd deletes the line, in the middle, at the end and when alone', () => {
    expect(type(normalAt('one\ntwo\nthree', 5), 'dd').text).toBe('one\nthree')
    expect(type(normalAt('one\ntwo\nthree', 9), 'dd').text).toBe('one\ntwo')
    expect(type(normalAt('only', 2), 'dd').text).toBe('')
  })

  test('D deletes to the end of the line', () => {
    expect(type(normalAt('hello world\nnext', 5), 'D').text).toBe('hello\nnext')
  })

  test('dw deletes to the next word and stops at the end of the line', () => {
    expect(type(normalAt('foo bar baz', 4), 'dw').text).toBe('foo baz')
    expect(type(normalAt('foo bar\nbaz', 4), 'dw').text).toBe('foo \nbaz')
  })

  test('d with other motions deletes what they cover', () => {
    expect(type(normalAt('foo bar baz', 4), 'de').text).toBe('foo  baz')
    expect(type(normalAt('foo bar baz', 4), 'db').text).toBe('bar baz')
    expect(type(normalAt('foo bar baz', 4), 'd$').text).toBe('foo ')
    expect(type(normalAt('foo bar baz', 4), 'd0').text).toBe('bar baz')
    expect(type(normalAt('a,b,c', 0), 'df,').text).toBe('b,c')
    expect(type(normalAt('a,b,c', 0), 'dt,').text).toBe(',b,c')
  })
})

describe('changing', () => {
  test('cw changes the word under the cursor and leaves the space after it', () => {
    const state = type(normalAt('foo bar baz', 4), 'cwX')
    expect(state.text).toBe('foo X baz')
    expect(state.mode).toBe('insert')
  })

  test('cc empties the line and starts typing in it', () => {
    expect(type(normalAt('one\ntwo\nthree', 5), 'ccX').text).toBe('one\nX\nthree')
  })

  test('C changes to the end of the line', () => {
    expect(type(normalAt('hello world', 5), 'CX').text).toBe('helloX')
  })

  test('s substitutes the character under the cursor', () => {
    expect(type(normalAt('hello', 0), 'sJ').text).toBe('Jello')
  })
})

describe('yanking and putting', () => {
  test('yy then p puts the line below, and P above', () => {
    expect(type(normalAt('one\ntwo', 1), 'yyp').text).toBe('one\none\ntwo')
    expect(type(normalAt('one\ntwo', 5), 'yyP').text).toBe('one\ntwo\ntwo')
  })

  test('dd then p moves a line down', () => {
    expect(type(normalAt('one\ntwo\nthree', 1), 'ddp').text).toBe('two\none\nthree')
  })

  test('a deleted word is put back after the cursor with p and at it with P', () => {
    expect(type(normalAt('foo bar', 0), 'dwP').text).toBe('foo bar')
    expect(type(normalAt('foo bar', 0), 'dwp').text).toBe('bfoo ar')
  })

  test('yw copies without changing the text', () => {
    const state = type(normalAt('foo bar', 0), 'ywwP')
    expect(state.text).toBe('foo foo bar')
  })

  test('putting with an empty register does nothing', () => {
    expect(type(normalAt('abc', 0), 'p').text).toBe('abc')
  })
})

describe('undo', () => {
  test('u takes back the last change, one at a time', () => {
    let state = type(normalAt('foo bar baz', 0), 'dwdw')
    expect(state.text).toBe('baz')
    state = type(state, 'u')
    expect(state.text).toBe('bar baz')
    state = type(state, 'u')
    expect(state.text).toBe('foo bar baz')
  })

  test('u takes back everything typed in one insert', () => {
    const state = type(normalAt('abc', 0), 'iXYZ<Esc>u')
    expect(state.text).toBe('abc')
  })

  test('an insert that typed nothing leaves nothing to undo', () => {
    const state = type(normalAt('abc', 0), 'x' + 'i<Esc>' + 'u')
    expect(state.text).toBe('abc')
  })

  test('u with nothing to undo does nothing', () => {
    expect(type(normalAt('abc', 1), 'u').text).toBe('abc')
  })
})

describe('visual mode', () => {
  test('v then motions select, and d deletes the selection', () => {
    const state = type(normalAt('hello world', 0), 'vlld')
    expect(state.text).toBe('lo world')
    expect(state.mode).toBe('normal')
  })

  test('the selection is shown from the anchor to the cursor, both included', () => {
    const state = type(normalAt('hello world', 2), 'vll')
    expect(vimSelection(state)).toEqual({ start: 2, end: 5 })
  })

  test('selecting backwards works the same way', () => {
    const state = type(normalAt('hello world', 4), 'vhhd')
    expect(state.text).toBe('he world')
  })

  test('y yanks the selection for p', () => {
    const state = type(normalAt('abc', 0), 'vly$p')
    expect(state.text).toBe('abcab')
  })

  test('c changes the selection and starts typing', () => {
    expect(type(normalAt('hello world', 0), 'vecX').text).toBe('X world')
  })

  test('w selects by word, and Escape or v leaves', () => {
    expect(vimSelection(type(normalAt('foo bar', 0), 'vw')).end).toBe(5)
    expect(type(normalAt('foo bar', 0), 'v<Esc>').mode).toBe('normal')
    expect(type(normalAt('foo bar', 0), 'vv').mode).toBe('normal')
  })
})

describe('the cursor', () => {
  test('is shown as the character it is on in normal mode', () => {
    expect(vimSelection(normalAt('abc', 1))).toEqual({ start: 1, end: 2 })
  })

  test('is a caret in insert mode and on an empty line', () => {
    expect(vimSelection(createVimState('abc'))).toEqual({ start: 3, end: 3 })
    expect(vimSelection(normalAt('', 0))).toEqual({ start: 0, end: 0 })
  })

  test('is put back on text when the draft changes under it', () => {
    const state = placeVimCursor(type(normalAt('abc', 0), 'v'), 'ab', 9)
    expect(state.mode).toBe('normal')
    expect(state.cursor).toBe(1)
  })

  test('a half-typed command is cancelled by Escape', () => {
    const state = type(normalAt('abc', 0), 'd<Esc>x')
    expect(state.text).toBe('bc')
  })
})
