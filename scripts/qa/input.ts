// Input the way a person gives it: the pointer and the keyboard, through XTEST.
//
// Every action is an `xdotool` call against the session's display. Points are in
// window coordinates, the same ones a screenshot's pixels have, so a position read
// off a screenshot is a position to click.

import { spawnSync } from 'node:child_process'

export interface Point {
  x: number
  y: number
}

/** Pointer moves a drag is split into, so a handler that sums movement sees all of it. */
export const DRAG_STEPS = 12

/** Pause between the moves of a drag, long enough for a frame to see each one. */
const DRAG_STEP_MS = 16

/** Pause between typed keys, which an editor needs to keep up with a burst. */
const TYPE_DELAY_MS = 12

/** Names for keys in the Playwright spelling the harness has always taken, as X keysyms. */
const KEY_NAMES: Record<string, string> = {
  control: 'ctrl',
  ctrl: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  meta: 'super',
  super: 'super',
  enter: 'Return',
  return: 'Return',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  backspace: 'BackSpace',
  delete: 'Delete',
  insert: 'Insert',
  space: 'space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  plus: 'plus',
  minus: 'minus'
}

/** Printable characters that are not their own keysym name. */
const CHARACTER_KEYSYMS: Record<string, string> = {
  ' ': 'space',
  '/': 'slash',
  '\\': 'backslash',
  '?': 'question',
  ':': 'colon',
  ';': 'semicolon',
  '.': 'period',
  ',': 'comma',
  '-': 'minus',
  '=': 'equal',
  '[': 'bracketleft',
  ']': 'bracketright',
  '{': 'braceleft',
  '}': 'braceright',
  '(': 'parenleft',
  ')': 'parenright',
  '<': 'less',
  '>': 'greater',
  "'": 'apostrophe',
  '"': 'quotedbl',
  '`': 'grave',
  '~': 'asciitilde',
  '!': 'exclam',
  '@': 'at',
  '#': 'numbersign',
  $: 'dollar',
  '%': 'percent',
  '^': 'asciicircum',
  '&': 'ampersand',
  '*': 'asterisk',
  _: 'underscore',
  '|': 'bar'
}

/**
 * One chord as xdotool's `key` takes it: `Control+s` becomes `ctrl+s`,
 * `Shift+Tab` becomes `shift+Tab`, and `?` becomes `question`.
 *
 * A `+` on its own, or at the end of a chord (`Control++`), is the plus key.
 */
export function keysymChord(chord: string): string {
  if (chord === '+') {
    return 'plus'
  }
  let parts = chord.split('+')
  if (chord.endsWith('++')) {
    parts = [...chord.slice(0, -2).split('+'), '+']
  }
  return parts.map(keysymFor).join('+')
}

/** A single key's keysym, from its Playwright name, its keysym name, or the character itself. */
function keysymFor(key: string): string {
  const named = KEY_NAMES[key.toLowerCase()]
  if (named !== undefined && key.length > 1) {
    return named
  }
  const character = CHARACTER_KEYSYMS[key]
  if (character !== undefined) {
    return character
  }
  if (key === '+') {
    return 'plus'
  }
  if (/^f\d{1,2}$/i.test(key)) {
    return key.toUpperCase()
  }
  return key
}

/**
 * The points a drag passes through after the press, ending on `to`: evenly
 * spaced, so the app sees a hand moving rather than a jump.
 */
export function dragPath(from: Point, to: Point, steps: number = DRAG_STEPS): Point[] {
  const points: Point[] = []
  for (let step = 1; step <= steps; step += 1) {
    const fraction = step / steps
    points.push({
      x: Math.round(from.x + (to.x - from.x) * fraction),
      y: Math.round(from.y + (to.y - from.y) * fraction)
    })
  }
  return points
}

/** Mouse buttons by the names the commands use. */
const BUTTONS = { left: 1, middle: 2, right: 3 } as const

export type ButtonName = keyof typeof BUTTONS

/** Drives one window on one display. */
export class Input {
  constructor(
    private readonly display: string,
    private readonly window: string
  ) {}

  /** Moves the pointer to a point in the window. */
  move(point: Point): void {
    this.run(['mousemove', '--window', this.window, '--sync', String(point.x), String(point.y)])
  }

  /** Moves to a point and clicks it, `count` times. */
  click(point: Point, button: ButtonName = 'left', count = 1): void {
    this.move(point)
    this.run(['click', '--repeat', String(count), '--delay', '60', String(BUTTONS[button])])
  }

  /** Presses at `from`, moves in steps to `to`, and releases there. */
  drag(from: Point, to: Point): void {
    this.move(from)
    this.run(['mousedown', '1'])
    Bun.sleepSync(DRAG_STEP_MS * 2)
    for (const point of dragPath(from, to)) {
      this.move(point)
      Bun.sleepSync(DRAG_STEP_MS)
    }
    Bun.sleepSync(DRAG_STEP_MS * 2)
    this.run(['mouseup', '1'])
  }

  /** Scrolls the wheel at a point: negative is up, in notches of about 50 pixels. */
  scroll(point: Point, pixels: number): void {
    this.move(point)
    const notches = Math.max(1, Math.round(Math.abs(pixels) / 50))
    let button = '5'
    if (pixels < 0) {
      button = '4'
    }
    this.run(['click', '--repeat', String(notches), '--delay', '20', button])
  }

  /** Types text into whatever has the keyboard. */
  type(text: string): void {
    this.run(['type', '--delay', String(TYPE_DELAY_MS), '--', text])
  }

  /** Presses chords one after another, in the Playwright spelling (`Control+s`). */
  press(chords: string[]): void {
    for (const chord of chords) {
      this.run(['key', '--delay', '40', keysymChord(chord)])
    }
  }

  /** Runs one xdotool command on the display, and fails loudly when it does. */
  private run(arguments_: string[]): void {
    const result = spawnSync('xdotool', arguments_, {
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: this.display }
    })
    if (result.status !== 0) {
      throw new Error(`xdotool ${arguments_.join(' ')} failed: ${result.stderr.trim()}`)
    }
  }
}
