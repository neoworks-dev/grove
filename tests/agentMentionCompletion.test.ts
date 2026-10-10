// Composer completion for `@` session mentions and `:name` emoji.

import { describe, expect, test } from 'bun:test'
import {
  activeCompletion,
  applyCompletion,
  sessionMentions,
  type MentionableSession
} from '../src/renderer/src/lib/agents/completion'
import { searchEmoji } from '../src/renderer/src/lib/agents/emoji'

/** The completion for a draft with the caret at its end. */
function complete(text: string) {
  return activeCompletion(text, text.length)
}

describe(':name emoji trigger', () => {
  test('opens after two characters at the start of the input', () => {
    expect(complete(':s')).toBeNull()
    expect(complete(':sm')).toEqual({ kind: 'emoji', query: 'sm', start: 0, end: 3 })
  })

  test('opens after whitespace', () => {
    expect(complete('nice :tada')).toEqual({ kind: 'emoji', query: 'tada', start: 5, end: 10 })
    expect(complete('nice\n:tada')?.kind).toBe('emoji')
  })

  test('stays closed inside words, urls and times', () => {
    expect(complete('http://example')).toBeNull()
    expect(complete('a:bc')).toBeNull()
    expect(complete('at 10:30')).toBeNull()
  })

  test('stays closed in a shell draft', () => {
    expect(complete('!echo :smile')?.kind).not.toBe('emoji')
    expect(complete('!!echo :smile')?.kind).not.toBe('emoji')
  })

  test('accepting writes the emoji in place of :name', () => {
    const text = 'good :tada'
    const completion = complete(text)!
    expect(applyCompletion(text, completion, '🎉')).toBe('good 🎉')
  })
})

describe('emoji search', () => {
  test('finds by prefix first, then by containing text', () => {
    const names = searchEmoji('sm').map((entry) => entry.name)
    expect(names[0]).toBe('smile')
    expect(searchEmoji('eart').map((entry) => entry.name)).toContain('heart')
  })

  test('finds nothing for an empty or unknown query', () => {
    expect(searchEmoji('')).toEqual([])
    expect(searchEmoji('zzzzqq')).toEqual([])
  })
})

const sessions: MentionableSession[] = [
  { id: 'current-1', title: 'Auth refactor', live: true, labels: { 'grove.agentId': 'aaaaaa' } },
  { id: 'other-2', title: 'Fix tab strip', live: true, labels: { 'grove.agentId': 'bbbbbb' } },
  { id: 'dead-3', title: 'Old tab work', live: false, labels: { 'grove.agentId': 'cccccc' } },
  { id: 'legacy-session-4', title: 'Legacy', live: true, labels: {} }
]

describe('@ session mentions', () => {
  test('@ with a letter is still a file completion', () => {
    expect(complete('see @ta')).toEqual({ kind: 'file', query: 'ta', start: 4, end: 7 })
  })

  test('suggests other live sessions by title, excluding the current one', () => {
    expect(sessionMentions(sessions, 'current-1', 'tab')).toEqual([
      { agentId: 'bbbbbb', title: 'Fix tab strip' }
    ])
    expect(sessionMentions(sessions, 'current-1', 'auth')).toEqual([])
  })

  test('matches by agent id, and falls back to the session id head', () => {
    expect(sessionMentions(sessions, 'current-1', 'bb')).toHaveLength(1)
    expect(sessionMentions(sessions, 'current-1', 'legacy-s')[0].agentId).toBe('legacy-s')
  })

  test('only a query starting with a letter asks for sessions', () => {
    expect(sessionMentions(sessions, 'current-1', '')).toEqual([])
    expect(sessionMentions(sessions, 'current-1', './b')).toEqual([])
    expect(sessionMentions(sessions, 'current-1', 'src/')).toHaveLength(0)
  })

  test('accepting writes the agent id as an @ mention', () => {
    const text = 'ask @bb'
    expect(applyCompletion(text, complete(text)!, 'bbbbbb')).toBe('ask @bbbbbb ')
  })
})
