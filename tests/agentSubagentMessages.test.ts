// What a subagent's messages are allowed to do to the conversation, and what
// tells grove a turn is in flight.
//
// The SDK streams a subagent's work on the same channel as the main agent's,
// marked only by `parent_tool_use_id`. Treating both alike ended the main
// agent's message mid-word and started a second bubble for the rest, and a turn
// the model started on its own (a background agent handing back) left the
// session reading as idle, with no Stop button on it.

import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { assistantEvents, signalsWork, streamEvents } from '../src/main/agents/harnesses/claude'

const TOOL_CALL = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
const ANSWER = { type: 'text', text: 'done' }

function textDelta(text: string): unknown {
  return { type: 'content_block_delta', delta: { type: 'text_delta', text } }
}

describe('assistantEvents', () => {
  test('the main agent ends its message', () => {
    const events = assistantEvents([ANSWER], null)

    expect(events.map((event) => event.type)).toEqual(['agent.message_end'])
  })

  test('a tool call is announced before the message that carries it ends', () => {
    const events = assistantEvents([TOOL_CALL], null)

    expect(events.map((event) => event.type)).toEqual(['agent.tool_use', 'agent.message_end'])
  })

  test("a subagent's calls count, but its message ends nothing", () => {
    const events = assistantEvents([TOOL_CALL, ANSWER], 'toolu_parent')

    expect(events.map((event) => event.type)).toEqual(['agent.tool_use'])
  })
})

describe('streamEvents', () => {
  test("the main agent's deltas stream", () => {
    expect(streamEvents(textDelta('hello'), null)).toEqual([
      { type: 'agent.message_delta', text: 'hello' }
    ])
  })

  test('thinking streams separately from the answer', () => {
    const event = { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } }

    expect(streamEvents(event, null)).toEqual([{ type: 'agent.thinking_delta', text: 'hm' }])
  })

  test("a subagent's deltas stay out of the conversation", () => {
    expect(streamEvents(textDelta('hello'), 'toolu_parent')).toEqual([])
    expect(streamEvents({ type: 'message_start' }, 'toolu_parent')).toEqual([])
  })
})

describe('signalsWork', () => {
  test('anything the model produces means the session is working', () => {
    const working: SDKMessage['type'][] = ['stream_event', 'assistant', 'user']

    for (const type of working) {
      expect(signalsWork({ type } as SDKMessage)).toBe(true)
    }
  })

  test('a finished turn does not', () => {
    expect(signalsWork({ type: 'result' } as SDKMessage)).toBe(false)
    expect(signalsWork({ type: 'system' } as SDKMessage)).toBe(false)
  })
})
