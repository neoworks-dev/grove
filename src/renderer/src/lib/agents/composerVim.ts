/**
 * A small vim for the agent composer. Not an nvim instance: the modes and the
 * commands a prompt is worth, worked out on the draft's text and the cursor.
 *
 * `handleVimKey` takes one keystroke and the state it left off in, and says what
 * the state is now and whether the key was used up. Insert mode leaves typing to
 * the textarea, so the caller hands in the draft and caret as they stand before
 * every key. Counts, registers other than the unnamed one, marks, macros and `.`
 * are left out.
 */

export type VimMode = 'normal' | 'insert' | 'visual'

/** What `d`, `c` and `y` last took, for `p` and `P` to put back. */
export interface VimRegister {
  text: string
  /** A whole line, which `p` puts on a line of its own. */
  linewise: boolean
}

interface VimSnapshot {
  text: string
  cursor: number
}

export interface VimState {
  mode: VimMode
  text: string
  /** The character the cursor is on; in insert mode, the caret's position. */
  cursor: number
  /** Where a visual selection began. */
  anchor: number
  /** Keys typed toward a command that needs more, such as `d`, `g` or `df`. */
  pending: string
  register: VimRegister
  undoStack: VimSnapshot[]
}

export interface VimInput {
  key: string
  ctrl: boolean
  alt: boolean
  meta: boolean
  shift: boolean
}

export interface VimResult {
  state: VimState
  /** The key was used here; the caller must not let it type or act. */
  handled: boolean
  /** The key asks for the draft to be sent. */
  send: boolean
}

interface Range {
  start: number
  end: number
}

const MAX_UNDO_STEPS = 100
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']
const FINDERS = ['f', 'F', 't', 'T']
const OPERATORS = ['d', 'c', 'y']

/** A new vim state for a draft. It starts in insert mode, the way the composer always has. */
export function createVimState(text: string): VimState {
  return {
    mode: 'insert',
    text,
    cursor: text.length,
    anchor: 0,
    pending: '',
    register: { text: '', linewise: false },
    undoStack: []
  }
}

/** The part of the text to show as selected: the cursor's character, a visual selection, or nothing. */
export function vimSelection(state: VimState): Range {
  if (state.mode === 'insert') return { start: state.cursor, end: state.cursor }
  if (state.mode === 'visual') return visualRange(state)
  if (state.cursor >= state.text.length || state.text[state.cursor] === '\n') {
    return { start: state.cursor, end: state.cursor }
  }
  return { start: state.cursor, end: state.cursor + 1 }
}

/** Puts the cursor where the user clicked or the text moved it, leaving visual mode. */
export function placeVimCursor(state: VimState, text: string, cursor: number): VimState {
  const placed = { ...state, text, pending: '' }
  if (state.mode === 'insert') return { ...placed, cursor: Math.min(cursor, text.length) }
  return { ...placed, mode: 'normal', cursor: clampNormal(text, cursor) }
}

/** Applies one keystroke. */
export function handleVimKey(state: VimState, input: VimInput): VimResult {
  if (MODIFIER_KEYS.includes(input.key)) return unhandled(state)
  if (input.ctrl || input.alt || input.meta) return unhandled(state)
  if (input.key === 'Enter' && !input.shift) return { state, handled: true, send: true }
  if (state.mode === 'insert') return handleInsertKey(state, input.key)
  if (state.mode === 'visual') return handleVisualKey(state, input.key)
  return handleNormalKey(state, input.key)
}

/** A key the caller should treat as it would without vim. */
function unhandled(state: VimState): VimResult {
  return { state, handled: false, send: false }
}

/** A key vim used up. */
function handled(state: VimState): VimResult {
  return { state, handled: true, send: false }
}

// ── Text geometry ───────────────────────────────────────────────

/** Where the line holding `index` begins. */
function lineStartOf(text: string, index: number): number {
  if (index <= 0) return 0
  return text.lastIndexOf('\n', index - 1) + 1
}

/** Where the line holding `index` ends: at its newline, or the end of the text. */
function lineEndOf(text: string, index: number): number {
  const end = text.indexOf('\n', index)
  if (end === -1) return text.length
  return end
}

/** The last character a normal-mode cursor can sit on in the line holding `index`. */
function lastColumnOf(text: string, index: number): number {
  const start = lineStartOf(text, index)
  const end = lineEndOf(text, index)
  if (end === start) return start
  return end - 1
}

/** The first character in the line that is not a blank. */
function firstNonBlankOf(text: string, index: number): number {
  const end = lineEndOf(text, index)
  let position = lineStartOf(text, index)
  while (position < end - 1 && /[ \t]/.test(text[position])) position++
  return position
}

/** Moves a cursor back onto a character a normal-mode cursor can rest on. */
function clampNormal(text: string, index: number): number {
  if (text.length === 0) return 0
  const bounded = Math.max(0, Math.min(index, text.length))
  if (bounded === text.length) {
    if (text[text.length - 1] === '\n') return bounded
    return bounded - 1
  }
  if (text[bounded] === '\n' && bounded > lineStartOf(text, bounded)) return bounded - 1
  return bounded
}

// ── Motions ─────────────────────────────────────────────────────

type CharacterClass = 'space' | 'word' | 'punctuation'

/** Whether a character is blank space, part of a word, or punctuation, which vim's word motions tell apart. */
function classOf(character: string): CharacterClass {
  if (/\s/.test(character)) return 'space'
  if (/[\p{L}\p{N}_]/u.test(character)) return 'word'
  return 'punctuation'
}

/** `w`: the start of the next word. */
function wordForward(text: string, from: number): number {
  let index = from
  if (index >= text.length) return text.length
  const startClass = classOf(text[index])
  if (startClass !== 'space') {
    while (index < text.length && classOf(text[index]) === startClass) index++
  }
  while (index < text.length && classOf(text[index]) === 'space') index++
  return index
}

/** `e`: the last character of this word, or of the next when already on its last. */
function wordEnd(text: string, from: number): number {
  let index = from + 1
  while (index < text.length && classOf(text[index]) === 'space') index++
  if (index >= text.length) return Math.max(0, text.length - 1)
  const kind = classOf(text[index])
  while (index + 1 < text.length && classOf(text[index + 1]) === kind) index++
  return index
}

/** `b`: the start of this word, or of the previous when already on its first. */
function wordBack(text: string, from: number): number {
  let index = from - 1
  while (index > 0 && classOf(text[index]) === 'space') index--
  if (index <= 0) return 0
  const kind = classOf(text[index])
  while (index > 0 && classOf(text[index - 1]) === kind) index--
  return index
}

/** The last character of the word the cursor is on. */
function wordEndInclusive(text: string, from: number): number {
  const kind = classOf(text[from])
  let index = from
  while (index + 1 < text.length && classOf(text[index + 1]) === kind) index++
  return index
}

/** `h` */
function moveLeft(text: string, cursor: number): number {
  if (cursor <= lineStartOf(text, cursor)) return cursor
  return cursor - 1
}

/** `l` */
function moveRight(text: string, cursor: number): number {
  if (cursor >= lastColumnOf(text, cursor)) return cursor
  return cursor + 1
}

/** `j`: the same column one line down, or the line's end when it is shorter. */
function moveDown(text: string, cursor: number): number {
  const end = lineEndOf(text, cursor)
  if (end >= text.length) return cursor
  const column = cursor - lineStartOf(text, cursor)
  const nextStart = end + 1
  return Math.min(nextStart + column, lastColumnOf(text, nextStart))
}

/** `k`: the same column one line up, or the line's end when it is shorter. */
function moveUp(text: string, cursor: number): number {
  const start = lineStartOf(text, cursor)
  if (start === 0) return cursor
  const column = cursor - start
  const previousStart = lineStartOf(text, start - 1)
  return Math.min(previousStart + column, lastColumnOf(text, previousStart))
}

/** `G`: the first non-blank of the last line. */
function toLastLine(text: string): number {
  return firstNonBlankOf(text, text.length)
}

/** `gg`: the first non-blank of the first line. */
function toFirstLine(text: string): number {
  return firstNonBlankOf(text, 0)
}

type Motion = (text: string, cursor: number) => number

const MOTIONS: Record<string, Motion> = {
  h: moveLeft,
  Backspace: moveLeft,
  l: moveRight,
  ' ': moveRight,
  j: moveDown,
  k: moveUp,
  w: wordForward,
  e: wordEnd,
  b: wordBack,
  '0': lineStartOf,
  $: lastColumnOf,
  '^': firstNonBlankOf,
  G: toLastLine
}

/** The character a find command (`f`, `F`, `t`, `T`) lands on, or -1 when the line has none. */
function findTarget(text: string, cursor: number, finder: string, character: string): number {
  const forward = finder === 'f' || finder === 't'
  const found = findCharacter(text, cursor, character, forward)
  if (found === -1) return -1
  if (finder === 't') return found - 1
  if (finder === 'T') return found + 1
  return found
}

/** The nearest `character` after or before the cursor on its line, or -1. */
function findCharacter(text: string, cursor: number, character: string, forward: boolean): number {
  if (forward) {
    const found = text.indexOf(character, cursor + 1)
    if (found === -1 || found >= lineEndOf(text, cursor)) return -1
    return found
  }
  if (cursor === 0) return -1
  const found = text.lastIndexOf(character, cursor - 1)
  if (found < lineStartOf(text, cursor)) return -1
  return found
}

// ── Ranges an operator acts on ──────────────────────────────────

type RangeOf = (text: string, cursor: number) => Range

/** Between two positions, whichever comes first. */
function between(first: number, second: number): Range {
  return { start: Math.min(first, second), end: Math.max(first, second) }
}

/** `dw`: up to the next word, but never into the next line. */
function wordRange(text: string, cursor: number): Range {
  const target = wordForward(text, cursor)
  return { start: cursor, end: Math.min(target, lineEndOf(text, cursor)) }
}

/** `cw`: on a word it changes only that word, up to its last character, as `ce` would. */
function changeWordRange(text: string, cursor: number): Range {
  if (cursor >= text.length || classOf(text[cursor]) === 'space') return wordRange(text, cursor)
  return { start: cursor, end: wordEndInclusive(text, cursor) + 1 }
}

const OPERATOR_RANGES: Record<string, RangeOf> = {
  w: wordRange,
  e: (text, cursor) => ({ start: cursor, end: wordEnd(text, cursor) + 1 }),
  b: (text, cursor) => ({ start: wordBack(text, cursor), end: cursor }),
  '0': (text, cursor) => ({ start: lineStartOf(text, cursor), end: cursor }),
  $: (text, cursor) => ({ start: cursor, end: lineEndOf(text, cursor) }),
  '^': (text, cursor) => between(firstNonBlankOf(text, cursor), cursor),
  h: (text, cursor) => ({ start: Math.max(lineStartOf(text, cursor), cursor - 1), end: cursor }),
  l: (text, cursor) => ({ start: cursor, end: Math.min(lineEndOf(text, cursor), cursor + 1) })
}

/** The characters from the cursor to a find command's target, as far as the operator takes them. */
function findRange(text: string, cursor: number, finder: string, character: string): Range | null {
  const target = findTarget(text, cursor, finder, character)
  if (target === -1) return null
  if (finder === 'f') return { start: cursor, end: target + 1 }
  if (finder === 't') return { start: cursor, end: Math.max(cursor, target + 1) }
  if (finder === 'F') return { start: target, end: cursor }
  return { start: Math.min(target, cursor), end: cursor }
}

/** The selected characters in visual mode, both ends included. */
function visualRange(state: VimState): Range {
  const low = Math.min(state.anchor, state.cursor)
  const high = Math.max(state.anchor, state.cursor)
  return { start: low, end: Math.min(high + 1, state.text.length) }
}

/** The whole line the cursor is on, without its newline. */
function lineRange(text: string, cursor: number): Range {
  return { start: lineStartOf(text, cursor), end: lineEndOf(text, cursor) }
}

// ── Changing the text ───────────────────────────────────────────

/** The state with the text as it is now remembered, for `u`. */
function withUndo(state: VimState): VimState {
  const kept = state.undoStack.slice(-(MAX_UNDO_STEPS - 1))
  return { ...state, undoStack: [...kept, { text: state.text, cursor: state.cursor }] }
}

/** Cuts a range out of the text and into the register. */
function cut(state: VimState, range: Range, linewise: boolean): VimState {
  const removed = state.text.slice(range.start, range.end)
  const next = withUndo(state)
  return {
    ...next,
    text: state.text.slice(0, range.start) + state.text.slice(range.end),
    cursor: range.start,
    register: { text: removed, linewise }
  }
}

/** Puts the cursor onto the character a normal-mode cursor can rest on, in normal mode. */
function settle(state: VimState): VimState {
  return { ...state, mode: 'normal', cursor: clampNormal(state.text, state.cursor) }
}

/** Starts typing at `cursor`. */
function startInserting(state: VimState, cursor: number): VimState {
  return { ...state, mode: 'insert', cursor, pending: '' }
}

/** Starts typing at `cursor`, remembering the text as it was so `u` takes the whole insert back. */
function beginInsert(state: VimState, cursor: number): VimState {
  return startInserting(withUndo(state), cursor)
}

/** Leaves insert mode, stepping the cursor back onto the last character typed. */
function leaveInsert(state: VimState): VimState {
  const last = state.undoStack[state.undoStack.length - 1]
  let stack = state.undoStack
  if (last !== undefined && last.text === state.text) stack = stack.slice(0, -1)
  const back = Math.max(lineStartOf(state.text, state.cursor), state.cursor - 1)
  return settle({ ...state, mode: 'normal', cursor: back, undoStack: stack })
}

/** Deletes a range of the line, as `d` with a motion does. */
function deleteRange(state: VimState, range: Range): VimState {
  if (range.end <= range.start) return state
  return settle(cut(state, range, false))
}

/** Copies a range into the register and puts the cursor at its start. */
function yankRange(state: VimState, range: Range, linewise: boolean): VimState {
  const text = state.text.slice(range.start, range.end)
  return settle({ ...state, cursor: range.start, register: { text, linewise } })
}

/** Deletes a range and starts typing where it was. */
function changeRange(state: VimState, range: Range): VimState {
  const next = cut(state, range, false)
  return startInserting(next, range.start)
}

/** `dd`: the line and its newline, or the newline before it when it is the last. */
function deleteLine(state: VimState): VimState {
  const line = lineRange(state.text, state.cursor)
  const register = { text: state.text.slice(line.start, line.end), linewise: true }
  let removed = { start: line.start, end: line.end + 1 }
  if (line.end >= state.text.length) removed = { start: Math.max(0, line.start - 1), end: line.end }
  const cutState = cut(state, removed, true)
  const position = firstNonBlankOf(cutState.text, Math.min(removed.start, cutState.text.length))
  return settle({ ...cutState, cursor: position, register })
}

/** `cc`: empties the line and starts typing in it. */
function changeLine(state: VimState): VimState {
  const line = lineRange(state.text, state.cursor)
  const next = cut(state, line, true)
  return startInserting(next, line.start)
}

/** `yy` */
function yankLine(state: VimState): VimState {
  const line = lineRange(state.text, state.cursor)
  const yanked = yankRange(state, line, true)
  return { ...yanked, cursor: clampNormal(state.text, state.cursor) }
}

/** `p` and `P`: puts the register after or before the cursor, or on the line below or above. */
function put(state: VimState, after: boolean): VimState {
  const register = state.register
  if (register.text === '' && !register.linewise) return state
  const next = withUndo(state)
  if (register.linewise) return putLine(next, after)
  return putCharacters(next, after)
}

/** A characterwise put. */
function putCharacters(state: VimState, after: boolean): VimState {
  const text = state.register.text
  let at = state.cursor
  if (after && state.text.length > 0) at = Math.min(state.cursor + 1, lineEndOf(state.text, state.cursor))
  const next = state.text.slice(0, at) + text + state.text.slice(at)
  return settle({ ...state, text: next, cursor: at + text.length - 1 })
}

/** A linewise put. */
function putLine(state: VimState, after: boolean): VimState {
  const text = state.register.text
  if (after) {
    const end = lineEndOf(state.text, state.cursor)
    const next = state.text.slice(0, end) + '\n' + text + state.text.slice(end)
    return settle({ ...state, text: next, cursor: firstNonBlankOf(next, end + 1) })
  }
  const start = lineStartOf(state.text, state.cursor)
  const next = state.text.slice(0, start) + text + '\n' + state.text.slice(start)
  return settle({ ...state, text: next, cursor: firstNonBlankOf(next, start) })
}

/** `u`: takes back the last change. */
function undo(state: VimState): VimState {
  const last = state.undoStack[state.undoStack.length - 1]
  if (last === undefined) return state
  const stack = state.undoStack.slice(0, -1)
  return settle({ ...state, text: last.text, cursor: last.cursor, undoStack: stack })
}

/** `x`: deletes the character under the cursor. */
function deleteCharacter(state: VimState): VimState {
  const end = Math.min(state.cursor + 1, lineEndOf(state.text, state.cursor))
  return deleteRange(state, { start: state.cursor, end })
}

/** `s`: deletes the character under the cursor and starts typing. */
function substituteCharacter(state: VimState): VimState {
  const end = Math.min(state.cursor + 1, lineEndOf(state.text, state.cursor))
  return changeRange(state, { start: state.cursor, end })
}

/** `D` */
function deleteToLineEnd(state: VimState): VimState {
  return deleteRange(state, { start: state.cursor, end: lineEndOf(state.text, state.cursor) })
}

/** `C` */
function changeToLineEnd(state: VimState): VimState {
  return changeRange(state, { start: state.cursor, end: lineEndOf(state.text, state.cursor) })
}

/** `o`: opens a line below and starts typing in it. */
function openLineBelow(state: VimState): VimState {
  const end = lineEndOf(state.text, state.cursor)
  const next = withUndo(state)
  const text = state.text.slice(0, end) + '\n' + state.text.slice(end)
  return startInserting({ ...next, text }, end + 1)
}

/** `O`: opens a line above and starts typing in it. */
function openLineAbove(state: VimState): VimState {
  const start = lineStartOf(state.text, state.cursor)
  const next = withUndo(state)
  const text = state.text.slice(0, start) + '\n' + state.text.slice(start)
  return startInserting({ ...next, text }, start)
}

/** `a`: starts typing after the cursor's character. */
function appendAfter(state: VimState): VimState {
  if (state.text.length === 0) return beginInsert(state, 0)
  return beginInsert(state, Math.min(state.cursor + 1, lineEndOf(state.text, state.cursor)))
}

// ── Keys, by mode ───────────────────────────────────────────────

type Command = (state: VimState) => VimState

const NORMAL_COMMANDS: Record<string, Command> = {
  x: deleteCharacter,
  s: substituteCharacter,
  D: deleteToLineEnd,
  C: changeToLineEnd,
  p: (state) => put(state, true),
  P: (state) => put(state, false),
  u: undo,
  i: (state) => beginInsert(state, state.cursor),
  I: (state) => beginInsert(state, firstNonBlankOf(state.text, state.cursor)),
  a: appendAfter,
  A: (state) => beginInsert(state, lineEndOf(state.text, state.cursor)),
  o: openLineBelow,
  O: openLineAbove,
  v: (state) => ({ ...state, mode: 'visual', anchor: state.cursor })
}

/** Whether a key is one character, which is all a command or a find takes. */
function isCharacter(key: string): boolean {
  return key.length === 1
}

/** A key in insert mode: Escape leaves it, everything else is typing. */
function handleInsertKey(state: VimState, key: string): VimResult {
  if (key === 'Escape') return handled(leaveInsert(state))
  return unhandled(state)
}

/** A key in normal mode. */
function handleNormalKey(state: VimState, key: string): VimResult {
  if (state.pending !== '') return handled(finishCommand(state, key))
  if (key === 'Escape') return unhandled(state)
  const command = NORMAL_COMMANDS[key]
  if (command !== undefined) return handled(command(state))
  const motion = MOTIONS[key]
  if (motion !== undefined) return handled(moveTo(state, motion(state.text, state.cursor)))
  if (isCharacter(key) && ['g', ...FINDERS, ...OPERATORS].includes(key)) {
    return handled({ ...state, pending: key })
  }
  if (isCharacter(key)) return handled(state)
  return unhandled(state)
}

/** A key in visual mode. */
function handleVisualKey(state: VimState, key: string): VimResult {
  if (state.pending !== '') return handled(finishCommand(state, key))
  if (key === 'Escape' || key === 'v') return handled(settle({ ...state, mode: 'normal' }))
  if (key === 'd' || key === 'x') return handled(deleteRange(leaveVisual(state), visualRange(state)))
  if (key === 'y') return handled(yankRange(leaveVisual(state), visualRange(state), false))
  if (key === 'c' || key === 's') return handled(changeRange(leaveVisual(state), visualRange(state)))
  const motion = MOTIONS[key]
  if (motion !== undefined) return handled(moveTo(state, motion(state.text, state.cursor)))
  if (isCharacter(key) && ['g', ...FINDERS].includes(key)) {
    return handled({ ...state, pending: key })
  }
  if (isCharacter(key)) return handled(state)
  return unhandled(state)
}

/** The state with visual mode ended, ahead of an edit that works on the selection. */
function leaveVisual(state: VimState): VimState {
  return { ...state, mode: 'normal' }
}

/** Moves the cursor, keeping it on text. */
function moveTo(state: VimState, target: number): VimState {
  return { ...state, cursor: clampNormal(state.text, target) }
}

/** The key that completes a command begun with one that needed another. */
function finishCommand(state: VimState, key: string): VimState {
  const pending = state.pending
  const cleared = { ...state, pending: '' }
  if (key === 'Escape') return cleared
  if (pending === 'g') return finishG(cleared, key)
  if (FINDERS.includes(pending)) return finishFind(cleared, pending, key)
  return finishOperator(cleared, pending, key)
}

/** `g` and a second key: only `gg` is known. */
function finishG(state: VimState, key: string): VimState {
  if (key !== 'g') return state
  return moveTo(state, toFirstLine(state.text))
}

/** A find command and the character it looks for. */
function finishFind(state: VimState, finder: string, character: string): VimState {
  if (!isCharacter(character)) return state
  const target = findTarget(state.text, state.cursor, finder, character)
  if (target === -1) return state
  return moveTo(state, target)
}

/** An operator and the key after it: a doubled operator, a find, or a motion. */
function finishOperator(state: VimState, pending: string, key: string): VimState {
  const operator = pending[0]
  const finder = pending.slice(1)
  if (finder !== '') return finishOperatorFind(state, operator, finder, key)
  if (key === operator) return operateOnLine(state, operator)
  if (isCharacter(key) && FINDERS.includes(key)) return { ...state, pending: operator + key }
  const rangeOf = operatorRangeFor(operator, key)
  if (rangeOf === undefined) return state
  return operateOnRange(state, operator, rangeOf(state.text, state.cursor))
}

/** The range a motion gives an operator; `cw` is the one place where the operator changes it. */
function operatorRangeFor(operator: string, key: string): RangeOf | undefined {
  if (operator === 'c' && key === 'w') return changeWordRange
  return OPERATOR_RANGES[key]
}

/** An operator waiting on a find, given the character. */
function finishOperatorFind(
  state: VimState,
  operator: string,
  finder: string,
  character: string
): VimState {
  if (!isCharacter(character)) return state
  const range = findRange(state.text, state.cursor, finder, character)
  if (range === null) return state
  return operateOnRange(state, operator, range)
}

/** `dd`, `cc` or `yy`. */
function operateOnLine(state: VimState, operator: string): VimState {
  if (operator === 'd') return deleteLine(state)
  if (operator === 'c') return changeLine(state)
  return yankLine(state)
}

/** `d`, `c` or `y` over a range of the line. */
function operateOnRange(state: VimState, operator: string, range: Range): VimState {
  if (operator === 'd') return deleteRange(state, range)
  if (operator === 'c') return changeRange(state, range)
  return yankRange(state, range, false)
}
