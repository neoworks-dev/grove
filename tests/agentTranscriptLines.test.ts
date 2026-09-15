// Folding a session's event log into lines somebody else can read.
//
// The rules worth pinning are the ones that decide what another agent sees:
// deltas must not double the finished message, an attachment must not be pasted
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

describe('transcript lines', () => {
  test('keeps the finished message and drops the deltas it was streamed as', () => {
    const lines = transcriptLines([
      event(1, { type: 'agent.message_start' }),
      event(2, { type: 'agent.message_delta', text: 'half ' }),
      event(3, { type: 'agent.thinking_delta', text: 'hmm' }),
      event(4, {
        type: 'agent.message_end',
        content: [{ type: 'text', text: 'half a thought' }],
        stopReason: 'end_turn'
      })
    ])

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ seq: 4, speaker: 'agent', text: 'half a thought' })
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
          type: 'agent.tool_result',
          toolUseId: 't',
          name: 'bash',
          content: 'x'.repeat(2000),
          isError: false
        })
      ],
      { includeTools: true }
    )

    expect(lines[0].text.length).toBeLessThan(500)
    expect(lines[0].text).toContain('(2000 chars)')
  })

  test('returns the newest hits when there are more than asked for', () => {
    const lines = transcriptLines(
      Array.from({ length: 5 }, (_unused, index) =>
        event(index + 1, {
          type: 'agent.message_end',
          content: [{ type: 'text', text: `pass ${index + 1} of the parser` }],
          stopReason: 'end_turn'
        })
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
