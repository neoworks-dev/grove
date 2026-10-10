// The detailed transcript's lines, and how it jumps and searches them. The key
// handling itself is shown in the app by driving Ctrl+O.

import { describe, expect, test } from 'bun:test'
import {
  applyEvent,
  createTranscript,
  visibleItems
} from '../src/renderer/src/lib/agents/transcript'
import {
  highlightSegments,
  matchingLines,
  promptLineFrom,
  stepMatch,
  viewerLinesOf
} from '../src/renderer/src/lib/agents/transcriptViewer'
import type { EventBody, SessionEvent } from '../src/renderer/src/lib/agents/types'

let nextSeq = 0

/** An event as the log records it, at a fixed time. */
function event(body: EventBody): SessionEvent {
  nextSeq += 1
  return {
    ...body,
    id: `evt_${nextSeq}`,
    seq: nextSeq,
    sessionId: 's1',
    createdAt: '2026-01-01T10:20:30.000Z'
  }
}

/** Folds a short conversation: two prompts, an answer to the first. */
function conversation() {
  nextSeq = 0
  const state = createTranscript()
  const bodies: EventBody[] = [
    { type: 'user.message', content: [{ type: 'text', text: 'first prompt' }] },
    {
      type: 'update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'the answer' }
      }
    },
    { type: 'user.message', content: [{ type: 'text', text: 'second prompt' }] }
  ]
  for (const body of bodies) applyEvent(state, event(body))
  return viewerLinesOf({
    items: visibleItems(state),
    createdAt: state.createdAt,
    model: 'test-model'
  })
}

describe('transcript viewer lines', () => {
  test('every message gets a header with its time, and the agent its model', () => {
    const headers = conversation().filter((line) => line.kind === 'header')
    expect(headers.map((line) => line.text.split(' · ').length)).toEqual([2, 3, 2])
    expect(headers[1].text).toContain('test-model')
  })

  test('prompts are the lines { and } jump between', () => {
    const lines = conversation()
    const first = promptLineFrom(lines, -1, 1)
    expect(first).toBe(0)
    const second = promptLineFrom(lines, first as number, 1)
    expect(lines[second as number].text.startsWith('you')).toBe(true)
    expect(promptLineFrom(lines, second as number, 1)).toBeNull()
    expect(promptLineFrom(lines, second as number, -1)).toBe(0)
  })
})

describe('transcript viewer search', () => {
  test('matches ignore case and n and N wrap around', () => {
    const lines = conversation()
    const matches = matchingLines(lines, 'PROMPT')
    expect(matches.length).toBe(2)
    expect(stepMatch(matches, matches[1], 1)).toBe(matches[0])
    expect(stepMatch(matches, matches[0], -1)).toBe(matches[1])
    expect(stepMatch([], 0, 1)).toBeNull()
  })

  test('a line is split at each occurrence for marking', () => {
    expect(highlightSegments('a b a', 'a')).toEqual([
      { text: 'a', match: true },
      { text: ' b ', match: false },
      { text: 'a', match: true }
    ])
  })
})
