// Which ended turns a session flags for the worktrees view.

import { describe, expect, test } from 'bun:test'
import { attentionOf } from '../src/renderer/src/lib/agents/attention'
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
    expect(attentionOf(event({ type: 'session.status_terminated', reason: 'crash' }))).toBe('failed')
  })

  test('a turn you stopped, and everything that is not a turn ending, asks nothing', () => {
    expect(attentionOf(event({ type: 'session.status_idle', stopReason: 'aborted' }))).toBeNull()
    expect(attentionOf(event({ type: 'agent.message_delta', text: 'x' }))).toBeNull()
  })
})
