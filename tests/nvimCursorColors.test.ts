// What the cursor is painted in.
//
// Reverse video was the only rule here, which meant the cursor took the colour
// of the token it sat on and vanished into a comment. nvim names a highlight
// per mode for exactly this, so the rule below is which of the two wins.

import { describe, expect, test } from 'bun:test'
import { createGridState } from '../src/renderer/src/lib/nvim/types'
import { defineHighlight } from '../src/renderer/src/lib/nvim/highlights'
import { cursorColors } from '../src/renderer/src/lib/nvim/canvasRenderer'

/** A grid with default colours and a dim comment highlight under the cursor. */
function gridWithComment(): ReturnType<typeof createGridState> {
  const state = createGridState()
  state.defaults = { fg: 0xfafafa, bg: 0x1c1c1e, sp: 0xff0000 }
  defineHighlight(state, 7, { foreground: 0x71717a })
  return state
}

describe('cursorColors', () => {
  test('a mode with no cursor highlight falls back to reverse video', () => {
    const state = gridWithComment()
    expect(cursorColors(state, 0, 7)).toEqual({ body: '#71717a', text: '#1c1c1e' })
    expect(cursorColors(state, undefined, 7)).toEqual({ body: '#71717a', text: '#1c1c1e' })
  })

  test('the mode cursor highlight wins over the token underneath', () => {
    const state = gridWithComment()
    defineHighlight(state, 9, { foreground: 0x0b0b0d, background: 0xfafafa })
    expect(cursorColors(state, 9, 7)).toEqual({ body: '#fafafa', text: '#0b0b0d' })
  })

  test('the same cursor highlight is used whatever the cursor sits on', () => {
    const state = gridWithComment()
    defineHighlight(state, 8, { foreground: 0x4ade80 })
    defineHighlight(state, 9, { foreground: 0x0b0b0d, background: 0xfafafa })
    expect(cursorColors(state, 9, 8)).toEqual(cursorColors(state, 9, 7))
  })

  test('a reversing cursor highlight resolves against the defaults', () => {
    const state = gridWithComment()
    defineHighlight(state, 9, { reverse: true })
    expect(cursorColors(state, 9, 7)).toEqual({ body: '#fafafa', text: '#1c1c1e' })
  })

  test('a cursor highlight with no colour of its own leaves reverse video alone', () => {
    const state = gridWithComment()
    defineHighlight(state, 9, { bold: true })
    expect(cursorColors(state, 9, 7)).toEqual({ body: '#71717a', text: '#1c1c1e' })
  })
})
