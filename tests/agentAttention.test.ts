// What a session flags for the worktrees view and the desktop notification:
// a turn that ended, or a call waiting on an approval mid-turn.

import { describe, expect, test } from 'bun:test'
import {
  attentionOf,
  foldAttention,
  type SessionAttention
} from '../src/renderer/src/lib/agents/attention'
import type { SessionEvent } from '../src/shared/agents'

function event(body: Record<string, unknown>): SessionEvent {
  return { ...body, id: 'e', seq: 1, sessionId: 's', createdAt: '' } as SessionEvent
}

describe('attentionOf', () => {
  test('a finished turn is done', () => {
    expect(attentionOf(event({ type: 'session.status_idle', stopReason: 'end_turn' }))).toBe('done')
  })

  test('a turn waiting on an answer needs you', () => {
    expect(attentionOf(event({ type: 'session.status_idle', stopReason: 'requires_action' }))).toBe(
      'needs_you'
    )
  })

  test('an error or a dead session failed', () => {
    expect(attentionOf(event({ type: 'session.status_idle', stopReason: 'error' }))).toBe('failed')
    expect(attentionOf(event({ type: 'session.status_terminated', reason: 'crash' }))).toBe(
      'failed'
    )
  })

  test('a turn you stopped, and everything that is not a turn ending, asks nothing', () => {
    expect(attentionOf(event({ type: 'session.status_idle', stopReason: 'aborted' }))).toBeNull()
    expect(
      attentionOf(
        event({
          type: 'update',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }
        })
      )
    ).toBeNull()
  })

  test('a call parked on an approval needs you, mid-turn', () => {
    expect(attentionOf(toolUse('t1', 'ask'))).toBe('needs_you')
    expect(attentionOf(toolUse('t1', 'allow'))).toBeNull()
  })
})

/**
 * A call the harness reported: parked on an approval (a permission request),
 * or run straight away (a plain tool call).
 */
function toolUse(toolCallId: string, permission: 'allow' | 'ask'): SessionEvent {
  const toolCall = { toolCallId, title: 'Bash', kind: 'execute', rawInput: {} }
  if (permission === 'ask') {
    return event({
      type: 'permission',
      request: { sessionId: 'h', toolCall, options: [] }
    })
  }
  return event({
    type: 'update',
    update: { sessionUpdate: 'tool_call', ...toolCall, status: 'in_progress' }
  })
}

function confirmation(toolUseId: string): SessionEvent {
  return event({ type: 'user.tool_confirmation', toolUseId, result: 'allow' })
}

/** The flag a session ends up with after these events, from none. */
function flagAfter(events: SessionEvent[]): SessionAttention | undefined {
  const parked = new Set<string>()
  let flag: SessionAttention | undefined
  for (const next of events) flag = foldAttention(flag, parked, next)
  return flag
}

describe('foldAttention', () => {
  test('an approval raises the flag while the turn is still running', () => {
    expect(flagAfter([event({ type: 'session.status_running' }), toolUse('t1', 'ask')])).toBe(
      'needs_you'
    )
  })

  test('answering the approval takes it down', () => {
    expect(flagAfter([toolUse('t1', 'ask'), confirmation('t1')])).toBeUndefined()
  })

  test('it stays up until the last parked call is answered', () => {
    expect(flagAfter([toolUse('t1', 'ask'), toolUse('t2', 'ask'), confirmation('t1')])).toBe(
      'needs_you'
    )
  })

  test('a call ending some other way counts as answered', () => {
    const result = event({
      type: 'update',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' }
    })
    expect(flagAfter([toolUse('t1', 'ask'), result])).toBeUndefined()
  })

  test('a call the harness ran without asking raises nothing', () => {
    expect(flagAfter([toolUse('t1', 'allow')])).toBeUndefined()
  })

  test('the turn ending after the approval says how it ended', () => {
    expect(
      flagAfter([
        toolUse('t1', 'ask'),
        confirmation('t1'),
        event({ type: 'session.status_idle', stopReason: 'end_turn' })
      ])
    ).toBe('done')
  })

  test('answering an approval leaves a flag of another kind alone', () => {
    const parked = new Set<string>()
    expect(foldAttention('failed', parked, confirmation('t1'))).toBe('failed')
  })
})
