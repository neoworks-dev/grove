// Where a mention starts and stops decides whether the popover appears at all,
// and getting it wrong is either a popover that never shows or one that will
// not go away. Both rules live in mentions.ts and are pinned here.

import { describe, it, expect } from 'bun:test'
import {
  activeMention,
  applyMention,
  rankMentions
} from '../src/renderer/src/kernel/plugins/github/mentions'

describe('activeMention', () => {
  it('opens on an @ at the start of the text', () => {
    expect(activeMention('@let', 4)).toEqual({ start: 0, query: 'let' })
  })

  it('opens on an @ after a space, and reports what has been typed', () => {
    expect(activeMention('ping @letsm', 11)).toEqual({ start: 5, query: 'letsm' })
  })

  it('opens on a bare @ with nothing typed yet', () => {
    expect(activeMention('ping @', 6)).toEqual({ start: 5, query: '' })
  })

  it('does not open mid-word, which is an email rather than a mention', () => {
    expect(activeMention('moritz@example.com', 18)).toBeNull()
  })

  it('stops at a space, so a finished mention is no longer active', () => {
    expect(activeMention('ping @letsmoe and', 17)).toBeNull()
  })

  it('stops at a newline', () => {
    expect(activeMention('@letsmoe\nnext', 13)).toBeNull()
  })

  it('reads the mention the caret is in, not a later one', () => {
    expect(activeMention('@one @two', 4)).toEqual({ start: 0, query: 'one' })
  })

  it('finds nothing in text with no @ at all', () => {
    expect(activeMention('nothing here', 12)).toBeNull()
  })
})

describe('applyMention', () => {
  it('completes the mention and leaves the caret after it', () => {
    const result = applyMention('ping @lets', { start: 5, query: 'lets' }, 'Letsmoe')
    expect(result.text).toBe('ping @Letsmoe ')
    expect(result.caret).toBe(14)
  })

  it('replaces the whole half-typed login, not just up to the caret', () => {
    // Caret sits after "@let", but "smoe" follows it in the text.
    const result = applyMention('ping @letsmoe!', { start: 5, query: 'let' }, 'Letsmoe')
    expect(result.text).toBe('ping @Letsmoe !')
  })

  it('keeps what follows the mention', () => {
    const result = applyMention('@lets please look', { start: 0, query: 'lets' }, 'Letsmoe')
    expect(result.text).toBe('@Letsmoe  please look')
  })
})

describe('rankMentions', () => {
  const logins = ['Letsmoe', 'moritz', 'other', 'someone-moe']

  it('puts prefix matches before ones that merely contain the query', () => {
    // "moritz" starts with it; "someone-moe" and "Letsmoe" only contain it.
    expect(rankMentions(logins, 'mo', 10)).toEqual(['moritz', 'Letsmoe', 'someone-moe'])
  })

  it('still offers a login that only contains the query', () => {
    expect(rankMentions(logins, 'moe', 10)).toEqual(['Letsmoe', 'someone-moe'])
  })

  it('ignores case, because GitHub logins do', () => {
    expect(rankMentions(logins, 'LETS', 10)).toEqual(['Letsmoe'])
  })

  it('offers everyone when nothing is typed yet', () => {
    expect(rankMentions(logins, '', 2)).toEqual(['Letsmoe', 'moritz'])
  })

  it('respects the limit', () => {
    expect(rankMentions(logins, 'o', 2)).toHaveLength(2)
  })
})
