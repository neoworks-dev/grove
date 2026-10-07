import { describe, expect, test } from 'bun:test'
import { rationaleOf, reasoningBefore } from '../src/main/agents/editRationale'
import type { AgentEditStep, SessionEvent } from '../src/shared/agents'

/** A log event with just what the rationale reads. */
function event(seq: number, body: Record<string, unknown>): SessionEvent {
  return { seq, id: `e${seq}`, createdAt: '2026-01-01T00:00:00Z', ...body } as unknown as SessionEvent
}

function said(seq: number, text: string): SessionEvent {
  return event(seq, {
    type: 'update',
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } }
  })
}

function thought(seq: number, text: string): SessionEvent {
  return event(seq, {
    type: 'update',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }
  })
}

function call(seq: number, toolCallId: string, rawInput: Record<string, unknown>): SessionEvent {
  return event(seq, {
    type: 'update',
    update: { sessionUpdate: 'tool_call', toolCallId, title: 'edit', kind: 'edit', rawInput }
  })
}

const step = { turnSeq: 1, seq: 7, toolCallId: 'edit-1' } as AgentEditStep

describe('why an edit was made', () => {
  test("keeps the turn's words and thoughts before the call, a paragraph per stretch", () => {
    const events = [
      said(0, 'from an earlier turn'),
      event(1, { type: 'user.message', content: [{ type: 'text', text: 'fix the parser' }] }),
      thought(2, 'The parser drops '),
      thought(3, 'the last token.'),
      call(4, 'read-1', { path: 'parser.ts' }),
      said(5, 'Found it: the loop stops one short.'),
      call(7, 'edit-1', { path: 'parser.ts', explanation: '  Loop to the end so the last token is kept. ' }),
      said(8, 'after the edit')
    ]
    expect(rationaleOf(events, step)).toEqual({
      explanation: 'Loop to the end so the last token is kept.',
      reasoning: 'The parser drops the last token.\n\nFound it: the loop stops one short.'
    })
  })

  test('a call without an explanation and a silent turn give empty strings', () => {
    const events = [call(7, 'edit-1', { path: 'parser.ts' })]
    expect(rationaleOf(events, step)).toEqual({ explanation: '', reasoning: '' })
  })

  test('a long turn keeps its end, nearest the edit', () => {
    const events = [said(2, `${'a'.repeat(5000)}END`)]
    const reasoning = reasoningBefore(events, 1, 7)
    expect(reasoning.length).toBe(4000)
    expect(reasoning.startsWith('…')).toBe(true)
    expect(reasoning.endsWith('END')).toBe(true)
  })
})
