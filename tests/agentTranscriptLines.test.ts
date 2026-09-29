// Folding a session's event log into lines somebody else can read.
//
// The rules worth pinning are the ones that decide what another agent sees:
// chunks must join into one message, an attachment must not be pasted
// a second time, and a search must come back with the newest hits rather than
// the first ones.

import { describe, expect, test } from 'bun:test'
import { renderHit, searchLines, transcriptLines } from '../src/main/agents/transcript'
import type { SessionEvent } from '../src/shared/agents'

function event(seq: number, body: Record<string, unknown>): SessionEvent {
  return {
    id: `e${seq}`,
    seq,
    sessionId: 's',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...body
  } as SessionEvent
}

/** One piece of an agent message or thought, as ACP streams it. */
function chunk(
  seq: number,
  text: string,
  kind: 'agent_message_chunk' | 'agent_thought_chunk' = 'agent_message_chunk',
  messageId?: string
): SessionEvent {
  return event(seq, {
    type: 'update',
    update: { sessionUpdate: kind, content: { type: 'text', text }, messageId }
  })
}

describe('transcript lines', () => {
  test('joins the chunks a message was streamed as into one line, leaving thoughts out', () => {
    const lines = transcriptLines([
      chunk(1, 'half '),
      chunk(2, 'hmm', 'agent_thought_chunk'),
      chunk(3, 'a thought')
    ])

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ seq: 1, speaker: 'agent', text: 'half a thought' })
  })

  test('a new message id starts a new line', () => {
    const lines = transcriptLines([chunk(1, 'first', undefined, 'm1'), chunk(2, 'second', undefined, 'm2')])

    expect(lines.map((line) => line.text)).toEqual(['first', 'second'])
  })

  test('names an attached file instead of repeating its contents', () => {
    const lines = transcriptLines([
      event(1, {
        type: 'user.message',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'file', path: 'src/a.ts', startLine: 12, endLine: 13, text: 'a\nb' }
        ]
      })
    ])

    expect(lines[0].text).toBe('look at this\n[src/a.ts:12-13]')
  })

  test('carries who an app message came from', () => {
    const lines = transcriptLines([
      event(1, { type: 'app.message', label: 'Agent message', from: 'Planner (id-a)', text: 'go' })
    ])

    expect(lines[0]).toMatchObject({ speaker: 'user', label: 'Planner (id-a)', text: 'go' })
  })

  test('truncates a long tool result rather than pasting the whole run', () => {
    const lines = transcriptLines(
      [
        event(1, {
          type: 'update',
          update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'bash', rawInput: {} }
        }),
        event(2, {
          type: 'update',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 't',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(2000) } }]
          }
        })
      ],
      { includeTools: true }
    )

    const result = lines.find((line) => line.seq === 2)
    expect(result?.text.length).toBeLessThan(500)
    expect(result?.text).toContain('(2000 chars)')
  })

  test('returns the newest hits when there are more than asked for', () => {
    const lines = transcriptLines(
      Array.from({ length: 5 }, (_unused, index) =>
        chunk(index + 1, `pass ${index + 1} of the parser`, undefined, `m${index + 1}`)
      )
    )

    expect(searchLines(lines, 'parser', 2).map((line) => line.seq)).toEqual([4, 5])
    expect(searchLines(lines, 'PARSER', 10)).toHaveLength(5)
    expect(searchLines(lines, '   ')).toEqual([])
  })

  test('flattens a hit onto one line', () => {
    const hit = renderHit({ seq: 7, at: '', speaker: 'agent', text: 'first\n\nsecond   third' })
    expect(hit).toBe('#7 agent: first second third')
  })
})
