// What a session looks like in a listing: the name taken from its first prompt,
// and the last message shown under it.

import { describe, expect, test } from 'bun:test'
import {
  firstPromptText,
  isDefaultTitle,
  lastMessagePreview,
  titleFromPrompt
} from '../src/main/agents/sessionSummary'
import type { SessionEvent } from '../src/shared/agents'

let seq = 0

/** An event as the store would stamp it. */
function stamped(body: Record<string, unknown>): SessionEvent {
  seq += 1
  return { ...body, id: `e${seq}`, seq, sessionId: 's', createdAt: '' } as SessionEvent
}

function userSays(text: string): SessionEvent {
  return stamped({ type: 'user.message', content: [{ type: 'text', text }] })
}

function agentSays(text: string): SessionEvent {
  return stamped({ type: 'agent.message_end', content: [{ type: 'text', text }], stopReason: 'end' })
}

describe('isDefaultTitle', () => {
  test('grove-made names are defaults', () => {
    expect(isDefaultTitle('Session')).toBe(true)
    expect(isDefaultTitle('Session 3')).toBe(true)
    expect(isDefaultTitle('')).toBe(true)
  })

  test('chosen names are not', () => {
    expect(isDefaultTitle('Inline edits')).toBe(false)
    expect(isDefaultTitle('Session cleanup')).toBe(false)
  })
})

describe('titleFromPrompt', () => {
  test('takes the first line that says something', () => {
    expect(titleFromPrompt('\n\nFix the tab strip\nIt overflows')).toBe('Fix the tab strip')
  })

  test('drops markdown markers', () => {
    expect(titleFromPrompt('## Make `grove` **faster**')).toBe('Make grove faster')
    expect(titleFromPrompt('- rename the store')).toBe('rename the store')
  })

  test('cuts a long line at a word boundary', () => {
    const title = titleFromPrompt(
      'Please refactor the layout tree so that fixed-size panes keep their width when siblings close'
    )
    expect(title).toBe('Please refactor the layout tree so that…')
  })

  test('nothing to name it by', () => {
    expect(titleFromPrompt('   \n  ')).toBeNull()
  })
})

describe('lastMessagePreview', () => {
  test('the last message with text, from either side, on one line', () => {
    const events = [userSays('hi'), agentSays('Done.\n\nChanged two files.'), stamped({ type: 'session.status_idle', stopReason: 'end' })]
    expect(lastMessagePreview(events)).toEqual({ from: 'agent', text: 'Done. Changed two files.' })
  })

  test("the user's own message when it is the latest", () => {
    expect(lastMessagePreview([agentSays('ok'), userSays('now the tests')])).toEqual({
      from: 'user',
      text: 'now the tests'
    })
  })

  test('markdown markers are dropped', () => {
    expect(lastMessagePreview([agentSays('`src/a.ts` created, **same** content')])?.text).toBe(
      'src/a.ts created, same content'
    )
  })

  test('none before anything is said', () => {
    expect(lastMessagePreview([])).toBeNull()
  })
})

describe('firstPromptText', () => {
  test('skips messages with no text', () => {
    const imageOnly = stamped({ type: 'user.message', content: [{ type: 'image', ref: 'x', mediaType: 'image/png' }] })
    expect(firstPromptText([imageOnly, userSays('first real prompt'), userSays('second')])).toBe(
      'first real prompt'
    )
  })
})
