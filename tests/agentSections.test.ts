// Transcript sections: one per user message, and whether each one's turn is
// over. A message steered into a running turn opens a section of its own, but
// the turn — and the calls the agent was making — carries on through it.

import { describe, expect, test } from 'bun:test'
import {
  applyEvent,
  createTranscript,
  turnInFlightSince,
  visibleItems
} from '../src/renderer/src/lib/agents/transcript'
import { sectionsOf } from '../src/renderer/src/lib/agents/sections'
import type { EventBody, SessionEvent } from '../src/renderer/src/lib/agents/types'

let nextSeq = 0

function event(body: EventBody): SessionEvent {
  nextSeq += 1
  return {
    ...body,
    id: `evt_${nextSeq}`,
    seq: nextSeq,
    sessionId: 's1',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

/** Folds a log and splits it into sections, as the agent pane does. */
function sectionsAfter(bodies: EventBody[]) {
  nextSeq = 0
  const state = createTranscript()
  for (const body of bodies) {
    applyEvent(state, event(body))
  }
  return sectionsOf(visibleItems(state), turnInFlightSince(state))
}

function say(text: string, deliverAs: 'steer' | 'followUp' = 'steer'): EventBody {
  return { type: 'user.message', content: [{ type: 'text', text }], deliverAs }
}

function answer(text: string): EventBody {
  return {
    type: 'update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
  }
}

/** A call reported and finished, as Claude Code reports a grove grep. */
function call(id: string): EventBody[] {
  return [
    {
      type: 'update',
      update: { sessionUpdate: 'tool_call', toolCallId: id, title: 'grep', status: 'pending' }
    },
    {
      type: 'update',
      update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' }
    }
  ]
}

const RUNNING: EventBody = { type: 'session.status_running' }
const IDLE: EventBody = { type: 'session.status_idle', stopReason: 'end_turn' }

describe('sectionsOf', () => {
  test('a message steered into a running turn leaves the section before it unsettled', () => {
    const sections = sectionsAfter([
      say('look into it'),
      RUNNING,
      answer('Looking.'),
      ...call('a'),
      ...call('b'),
      say('also this'),
      answer('On it.'),
      ...call('c')
    ])

    expect(sections.map((section) => section.settled)).toEqual([false, false])
  })

  test('once the turn ends, every section it ran through settles', () => {
    const sections = sectionsAfter([
      say('look into it'),
      RUNNING,
      answer('Looking.'),
      ...call('a'),
      say('also this'),
      ...call('b'),
      answer('Done.'),
      IDLE
    ])

    expect(sections.map((section) => section.settled)).toEqual([true, true])
  })

  test('a message that started the turn in flight settles the turns before it', () => {
    const sections = sectionsAfter([
      say('first'),
      RUNNING,
      answer('One.'),
      IDLE,
      say('second'),
      RUNNING,
      ...call('a')
    ])

    expect(sections.map((section) => section.settled)).toEqual([true, false])
  })

  test('a message queued during one turn and started as the next settles the one it waited on', () => {
    const sections = sectionsAfter([
      say('first'),
      RUNNING,
      ...call('a'),
      say('queued', 'followUp'),
      answer('One.'),
      IDLE,
      RUNNING,
      ...call('b')
    ])

    expect(sections.map((section) => section.settled)).toEqual([true, false])
  })

  test('calls made after a steered message stay in its section', () => {
    const sections = sectionsAfter([
      say('look into it'),
      RUNNING,
      ...call('a'),
      say('also this'),
      answer('Sure.'),
      ...call('b')
    ])

    const bodies = sections.map((section) =>
      section.body.flatMap((item) => (item.kind === 'tool' ? [item.toolUseId] : []))
    )
    expect(bodies).toEqual([['a'], ['b']])
  })

  test('a steered message joins the transcript where the agent takes it up, not where it was typed', () => {
    const sections = sectionsAfter([
      say('look into it'),
      RUNNING,
      ...call('a'),
      say('also this'),
      ...call('b'),
      answer('Sure.'),
      ...call('c')
    ])

    const bodies = sections.map((section) =>
      section.body.flatMap((item) => (item.kind === 'tool' ? [item.toolUseId] : []))
    )
    expect(bodies).toEqual([['a', 'b'], ['c']])
  })
})
