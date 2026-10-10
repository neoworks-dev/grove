// Up on an empty composer right after an interrupt: which prompt comes back, when
// the press has to wait for the stop to land, and that a second press does not go
// further back.

import { describe, expect, test } from 'bun:test'
import type { SessionEvent } from '../src/shared/agents'
import {
  interruptedPrompt,
  interruptRestoreAction
} from '../src/renderer/src/lib/agents/interruptRestore'
import { rewindConversationEvents } from '../src/renderer/src/lib/agents/rewind'
import { applyEvent, createTranscript } from '../src/renderer/src/lib/agents/transcript'
import type { TranscriptState } from '../src/renderer/src/lib/agents/transcript'

type Body = Record<string, unknown>

/** A log as the store would stamp it, seq from 1. */
function transcriptOf(bodies: Body[]): TranscriptState {
  const state = createTranscript()
  bodies.forEach((body, index) => {
    const event = { ...body, id: `e${index + 1}`, seq: index + 1, sessionId: 's', createdAt: '' }
    applyEvent(state, event as SessionEvent)
  })
  return state
}

function say(text: string): Body {
  return { type: 'user.message', content: [{ type: 'text', text }] }
}

function reply(text: string, messageId: string): Body {
  return {
    type: 'update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId }
  }
}

const running: Body = { type: 'session.status_running' }
const finished: Body = { type: 'session.status_idle', stopReason: 'end_turn' }
const stopped: Body = { type: 'session.status_idle', stopReason: 'aborted' }
const interrupt: Body = { type: 'user.interrupt' }

const settled = { harnessRewinds: true, stopRequested: false, restoredTurn: 0 }

describe('the prompt of an interrupted turn', () => {
  test('is the prompt that started the turn that was stopped', () => {
    const state = transcriptOf([
      say('first'),
      running,
      reply('one', 'm1'),
      finished,
      say('second'),
      running,
      interrupt,
      stopped
    ])
    expect(interruptedPrompt(state, 0)?.text).toBe('second')
  })

  test('is none when the turn ended on its own', () => {
    const state = transcriptOf([say('first'), running, reply('one', 'm1'), finished])
    expect(interruptedPrompt(state, 0)).toBeNull()
  })

  test('is none while the turn is still running', () => {
    const state = transcriptOf([say('first'), running, interrupt])
    expect(interruptedPrompt(state, 0)).toBeNull()
  })

  test('is none once that turn was already put back', () => {
    const state = transcriptOf([say('first'), running, interrupt, stopped])
    expect(interruptedPrompt(state, 0)?.text).toBe('first')
    expect(interruptedPrompt(state, state.turnStartSeq)).toBeNull()
  })
})

describe('what up does on an empty composer', () => {
  test('restores the interrupted prompt once the stop has landed', () => {
    const state = transcriptOf([say('first'), running, interrupt, stopped])
    const action = interruptRestoreAction(state, settled)
    expect(action.kind).toBe('restore')
    if (action.kind !== 'restore') return
    expect(action.prompt.text).toBe('first')
    // The conversation goes back to before the prompt; no code is touched.
    expect(rewindConversationEvents(state, action.prompt)).toEqual([
      { type: 'user.branch', fromSeq: 0 }
    ])
  })

  test('waits when the stop was asked for and the turn has not ended', () => {
    const state = transcriptOf([say('first'), running, interrupt])
    expect(interruptRestoreAction(state, { ...settled, stopRequested: true })).toEqual({
      kind: 'wait'
    })
  })

  test('steps through history while a turn runs that nobody asked to stop', () => {
    const state = transcriptOf([say('first'), running])
    expect(interruptRestoreAction(state, settled)).toEqual({ kind: 'none' })
  })

  test('steps through history after a turn that ended on its own', () => {
    const state = transcriptOf([say('first'), running, reply('one', 'm1'), finished])
    expect(interruptRestoreAction(state, settled)).toEqual({ kind: 'none' })
  })

  test('leaves up alone on a harness that cannot take a conversation back', () => {
    const state = transcriptOf([say('first'), running, interrupt, stopped])
    expect(interruptRestoreAction(state, { ...settled, harnessRewinds: false })).toEqual({
      kind: 'none'
    })
  })

  test('a second press after the restore does not rewind the turn before', () => {
    const state = transcriptOf([
      say('first'),
      running,
      reply('one', 'm1'),
      finished,
      say('second'),
      running,
      interrupt,
      stopped
    ])
    const turn = state.turnStartSeq
    // The restore went through: the branch is on the log, the stale stop reason is not.
    applyEvent(state, {
      type: 'user.branch',
      fromSeq: 4,
      id: 'b',
      seq: 9,
      sessionId: 's',
      createdAt: ''
    } as SessionEvent)
    applyEvent(state, {
      type: 'session.branched',
      fromSeq: 4,
      id: 'c',
      seq: 10,
      sessionId: 's',
      createdAt: ''
    } as SessionEvent)
    expect(interruptRestoreAction(state, { ...settled, restoredTurn: turn })).toEqual({
      kind: 'none'
    })
  })
})
