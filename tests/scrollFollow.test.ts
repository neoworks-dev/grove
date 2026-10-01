// The agent transcript following its newest output across scroll events.

import { describe, expect, test } from 'bun:test'
import { followsAfterScroll } from '../src/renderer/src/lib/agents/scrollFollow'

describe('followsAfterScroll', () => {
  test('keeps following when content grew between the scroll to the bottom and its event', () => {
    // Scrolled to 1000 of 1400 (bottom); 300px of output landed before the event.
    const position = { scrollTop: 1000, scrollHeight: 1700, clientHeight: 400 }
    expect(followsAfterScroll(true, 900, position)).toBe(true)
  })

  test('stops following when the user scrolls up away from the bottom', () => {
    const position = { scrollTop: 600, scrollHeight: 1400, clientHeight: 400 }
    expect(followsAfterScroll(true, 1000, position)).toBe(false)
  })

  test('a small nudge up near the bottom still follows', () => {
    const position = { scrollTop: 980, scrollHeight: 1400, clientHeight: 400 }
    expect(followsAfterScroll(true, 1000, position)).toBe(true)
  })

  test('scrolling back down to the bottom resumes following', () => {
    const position = { scrollTop: 1000, scrollHeight: 1400, clientHeight: 400 }
    expect(followsAfterScroll(false, 700, position)).toBe(true)
  })

  test('scrolling down short of the bottom does not resume following', () => {
    const position = { scrollTop: 800, scrollHeight: 1400, clientHeight: 400 }
    expect(followsAfterScroll(false, 700, position)).toBe(false)
  })
})
