// Drafts sent mid-turn, kept per session under the text they were sent as, so taking a
// message back restores the composer's own draft rather than a copy rebuilt from the send.

import { describe, expect, test } from 'bun:test'
import { SentDrafts } from '../src/renderer/src/lib/agents/sentDrafts'

describe('SentDrafts', () => {
  test('takes back the newest draft sent as that text, once', () => {
    const drafts = new SentDrafts<string>(8)
    drafts.keep('s1', 'look', 'first draft')
    drafts.keep('s1', 'look', 'second draft')

    expect(drafts.take('s1', 'look')).toBe('second draft')
    expect(drafts.take('s1', 'look')).toBe('first draft')
    expect(drafts.take('s1', 'look')).toBeNull()
  })

  test('keeps sessions apart', () => {
    const drafts = new SentDrafts<string>(8)
    drafts.keep('s1', 'look', 'from s1')

    expect(drafts.take('s2', 'look')).toBeNull()
    expect(drafts.take('s1', 'look')).toBe('from s1')
  })

  test('hands back the oldest drafts past the limit, for releasing', () => {
    const drafts = new SentDrafts<string>(2)
    expect(drafts.keep('s1', 'a', 'A')).toEqual([])
    expect(drafts.keep('s1', 'b', 'B')).toEqual([])
    expect(drafts.keep('s1', 'c', 'C')).toEqual(['A'])
    expect(drafts.clear()).toEqual(['B', 'C'])
  })
})
