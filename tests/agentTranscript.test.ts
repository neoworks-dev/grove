// The renderer's fold of a session log — ACP updates as the harness reported
// them, and grove's own events — into what the agent pane draws.

import { describe, expect, test } from 'bun:test'
import {
  applyEvent,
  createTranscript,
  pendingApprovals,
  toolCallOut,
  visibleItems,
  visiblePanels,
  type TranscriptItem
} from '../src/renderer/src/lib/agents/transcript'
import {
  inputViewOf,
  labelFor,
  languageOfInput,
  resultViewOf
} from '../src/renderer/src/lib/agents/tools'
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

function textsOf(items: TranscriptItem[]): string[] {
  return items.flatMap((item) => ('text' in item ? [item.text] : []))
}

function fold(bodies: EventBody[]) {
  nextSeq = 0
  const state = createTranscript()
  for (const body of bodies) {
    applyEvent(state, event(body))
  }
  return state
}

/** A piece of the agent's message, as ACP streams it. */
function chunk(text: string, messageId?: string): EventBody {
  return {
    type: 'update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId }
  }
}

function thought(text: string): EventBody {
  return {
    type: 'update',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }
  }
}

/** A call as the harness first reports it. */
function toolCall(toolCallId: string, name: string, rawInput: unknown): EventBody {
  return {
    type: 'update',
    update: { sessionUpdate: 'tool_call', toolCallId, name, title: name, status: 'in_progress', rawInput }
  } as EventBody
}

/** A call settling with a text result. */
function toolResult(
  toolCallId: string,
  text: string,
  status: 'completed' | 'failed' = 'completed'
): EventBody {
  return {
    type: 'update',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status,
      content: [{ type: 'content', content: { type: 'text', text } }]
    }
  }
}

/** A call parked on the user's approval. */
function permission(toolCallId: string, name: string, rawInput: unknown): EventBody {
  return {
    type: 'permission',
    request: { sessionId: 'h1', toolCall: { toolCallId, name, title: name, rawInput }, options: [] }
  } as EventBody
}

/** The harness's plan with one entry. */
function plan(status: 'pending' | 'in_progress' | 'completed'): EventBody {
  return {
    type: 'update',
    update: { sessionUpdate: 'plan', entries: [{ content: 'Read', status, priority: 'medium' }] }
  }
}

describe('transcript fold', () => {
  test('assembles a streamed agent turn', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      { type: 'session.status_running' },
      thought('hmm'),
      chunk('he'),
      chunk('llo'),
      { type: 'session.status_idle', stopReason: 'end_turn' }
    ])

    expect(state.items).toEqual([
      {
        kind: 'user',
        seq: 1,
        eventId: 'evt_1',
        text: 'hi',
        attachments: [],
        references: [],
        pending: false
      },
      {
        kind: 'agent',
        seq: 3,
        eventId: 'evt_3',
        messageId: null,
        thinking: 'hmm',
        text: 'hello',
        streaming: false
      }
    ])
    expect(state.status).toBe('idle')
    expect(state.stopReason).toBe('end_turn')
  })

  test('a message written mid-turn waits until the agent starts its next message', () => {
    const steered = {
      type: 'user.message',
      content: [{ type: 'text', text: 'also this' }]
    } as const
    const waiting = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'go' }] },
      { type: 'session.status_running' },
      chunk('on it'),
      steered
    ])
    const taken = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'go' }] },
      { type: 'session.status_running' },
      chunk('on it'),
      steered,
      chunk('and that too')
    ])

    expect(waiting.items.map((item) => item.kind === 'user' && item.pending)).toEqual([
      false,
      false,
      true
    ])
    expect(taken.items.some((item) => item.kind === 'user' && item.pending)).toBe(false)
  })

  test('a new harness conversation empties the transcript without losing the log', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'first' }] },
      { type: 'session_changed', sessionId: 'h2' },
      { type: 'user.message', content: [{ type: 'text', text: 'second' }] }
    ])

    expect(textsOf(visibleItems(state))).toEqual(['second'])
    expect(state.items).toHaveLength(2)
  })

  test('a harness-run command reads back as the line typed, its output as the agent', () => {
    const state = fold([
      { type: 'user.command', name: 'usage', args: '' },
      chunk('Session cost: $0.42')
    ])

    expect(visibleItems(state).map((item) => item.kind)).toEqual(['user', 'agent'])
    expect(textsOf(visibleItems(state))).toEqual(['/usage', 'Session cost: $0.42'])
  })

  test('an attached file slice is a chip, not part of the message text', () => {
    const state = fold([
      {
        type: 'user.message',
        content: [
          { type: 'text', text: 'explain this' },
          {
            type: 'file',
            path: 'src/a.ts',
            startLine: 12,
            endLine: 14,
            text: 'const a = 1\nconst b = 2\nconst c = 3'
          }
        ]
      }
    ])

    const [item] = state.items
    expect(item).toMatchObject({ kind: 'user', text: 'explain this' })
    expect(item.kind === 'user' && item.references).toEqual([
      {
        type: 'file',
        path: 'src/a.ts',
        startLine: 12,
        endLine: 14,
        text: 'const a = 1\nconst b = 2\nconst c = 3'
      }
    ])
  })

  test('renders application context separately from user-authored messages', () => {
    const feedback = 'The user reviewed your changes.\n\na.ts:\n  Reverted hunk(s) 1.'
    const state = fold([
      {
        type: 'app.message',
        label: 'Review feedback',
        text: feedback,
        deliverAs: 'steer'
      },
      {
        type: 'user.message',
        content: [{ type: 'text', text: 'The user reviewed your changes.' }]
      }
    ])

    expect(state.items[0]).toEqual({
      kind: 'app',
      seq: 1,
      eventId: 'evt_1',
      label: 'Review feedback',
      text: feedback
    })
    expect(state.items[1]).toMatchObject({ kind: 'user' })
  })

  test('keeps attachment refs on a user message', () => {
    const state = fold([
      {
        type: 'user.message',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', ref: 'a'.repeat(64), mediaType: 'image/png' }
        ]
      }
    ])

    expect(state.items[0]).toMatchObject({
      text: 'what is this?',
      attachments: [{ ref: 'a'.repeat(64), mediaType: 'image/png' }]
    })
  })

  test('a turn that only called tools leaves no empty agent block', () => {
    const state = fold([toolCall('t1', 'bash', {})])

    expect(state.items.map((item) => item.kind)).toEqual(['tool'])
  })

  test('a new message id starts a new agent block', () => {
    const state = fold([chunk('first', 'm1'), chunk('second', 'm2')])

    expect(textsOf(state.items)).toEqual(['first', 'second'])
  })

  test("records an edited tool input alongside the model's own", () => {
    const state = fold([
      permission('t1', 'bash', { command: 'rm -rf /' }),
      { type: 'user.tool_confirmation', toolUseId: 't1', result: 'allow', input: { command: 'ls' } }
    ])

    expect(state.items[0]).toMatchObject({
      input: { command: 'rm -rf /' },
      editedInput: { command: 'ls' }
    })
  })

  test('shows a shell escape and whether the model saw it', () => {
    const state = fold([
      {
        type: 'session.shell_result',
        command: 'git status',
        output: 'clean',
        exitCode: 0,
        outcome: 'completed',
        share: false
      }
    ])

    expect(state.items[0]).toMatchObject({ kind: 'shell', command: 'git status', shared: false })
  })

  test('shared output waits for a message, and is marked until one is sent', () => {
    const shellRun = {
      type: 'session.shell_result' as const,
      command: 'git status',
      output: 'clean',
      exitCode: 0,
      outcome: 'exit 0',
      share: true
    }

    const waiting = fold([shellRun])
    expect(waiting.items[0]).toMatchObject({ kind: 'shell', shared: true, delivered: false })

    const sent = fold([
      shellRun,
      { type: 'user.message', content: [{ type: 'text', text: 'fix' }] }
    ])
    expect(sent.items[0]).toMatchObject({ kind: 'shell', shared: true, delivered: true })
  })

  test('a retracted message leaves the view', () => {
    const state = createTranscript()
    const message = event({ type: 'user.message', content: [{ type: 'text', text: 'never mind' }] })

    applyEvent(state, message)
    applyEvent(state, event({ type: 'user.unqueue', messageId: message.id }))

    expect(state.items.some((item) => item.kind === 'user')).toBe(false)
  })

  test('branching takes the abandoned turns out of view without losing them', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'first' }] }, // 1
      chunk('rep'), // 2
      chunk('ly'), // 3
      { type: 'session.status_idle', stopReason: 'end_turn' }, // 4
      { type: 'user.message', content: [{ type: 'text', text: 'wrong turn' }] }, // 5
      { type: 'session.branched', fromSeq: 4 } // 6
    ])

    expect(textsOf(visibleItems(state))).toEqual(['first', 'reply'])
    // Still there, which is what lets the tree panel put it back.
    expect(textsOf(state.items)).toContain('wrong turn')
  })

  test('branching back to an abandoned head brings the whole branch into view', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'first' }] }, // 1
      { type: 'user.message', content: [{ type: 'text', text: 'original' }] }, // 2
      { type: 'session.branched', fromSeq: 1 }, // 3
      { type: 'user.message', content: [{ type: 'text', text: 'alternative' }] }, // 4
      { type: 'session.branched', fromSeq: 2 } // 5
    ])

    expect(textsOf(visibleItems(state))).toEqual(['first', 'original'])
  })

  test("a new turn after branching does not reuse the abandoned branch's open message", () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'first' }] }, // 1
      chunk('half a thou'), // 2
      { type: 'session.branched', fromSeq: 1 }, // 3
      chunk('a fresh answer') // 4
    ])

    expect(textsOf(visibleItems(state))).toEqual(['first', 'a fresh answer'])
  })

  test('the request to branch is not itself part of the transcript', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'first' }] }, // 1
      { type: 'user.branch', fromSeq: 0 }, // 2
      { type: 'session.branched', fromSeq: 0 }, // 3
      { type: 'user.message', content: [{ type: 'text', text: 'starting over' }] } // 4
    ])

    expect(textsOf(visibleItems(state))).toEqual(['starting over'])
  })

  test('tracks a tool call from approval to result', () => {
    const state = fold([
      toolCall('t1', 'bash', { command: 'ls' }),
      permission('t1', 'bash', { command: 'ls' }),
      { type: 'session.status_idle', stopReason: 'requires_action' }
    ])

    expect(pendingApprovals(state).map((tool) => tool.toolUseId)).toEqual(['t1'])

    applyEvent(state, event({ type: 'user.tool_confirmation', toolUseId: 't1', result: 'allow' }))
    expect(state.items[0]).toMatchObject({ status: 'running' })

    applyEvent(state, event(toolResult('t1', 'a\nb')))
    expect(state.items[0]).toMatchObject({ status: 'ok', result: 'a\nb' })
    expect(pendingApprovals(state)).toEqual([])
  })

  // The working bar is for the model writing; while a call is out, the call's
  // own row says the agent is busy.
  test('knows when the turn is out on a tool call rather than with the model', () => {
    const state = fold([
      { type: 'session.status_running' },
      chunk('Let me look.')
    ])
    expect(toolCallOut(state)).toBe(false)

    applyEvent(state, event(permission('t1', 'bash', {})))
    expect(toolCallOut(state)).toBe(true)

    applyEvent(state, event({ type: 'user.tool_confirmation', toolUseId: 't1', result: 'allow' }))
    expect(toolCallOut(state)).toBe(true)

    applyEvent(state, event(toolResult('t1', '')))
    expect(toolCallOut(state)).toBe(false)
  })

  // A harness reports a call as the model makes it and only then asks for it to
  // be approved, so the same call arrives twice.
  test('a call asked about after it was reported becomes pending in place', () => {
    const state = fold([toolCall('t1', 'write', { path: 'a' }), permission('t1', 'write', { path: 'a' })])

    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ status: 'pending', permission: 'ask' })
    expect(pendingApprovals(state).map((tool) => tool.toolUseId)).toEqual(['t1'])
  })

  // Claude Code reports a slow MCP call as in progress every 30 seconds,
  // whether or not it has been approved yet.
  test('a pending call stays pending through progress reports until it is decided', () => {
    const heartbeat = {
      type: 'update',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }
    } as EventBody
    const state = fold([toolCall('t1', 'rename', {}), permission('t1', 'rename', {}), heartbeat])

    expect(pendingApprovals(state).map((tool) => tool.toolUseId)).toEqual(['t1'])

    applyEvent(state, event({ type: 'user.tool_confirmation', toolUseId: 't1', result: 'allow' }))
    applyEvent(state, event(heartbeat))
    expect(state.items[0]).toMatchObject({ status: 'running' })
  })

  test('marks a denied tool call and an errored result', () => {
    const state = fold([
      permission('t1', 'write', {}),
      { type: 'user.tool_confirmation', toolUseId: 't1', result: 'deny' },
      toolCall('t2', 'read', {}),
      toolResult('t2', 'boom', 'failed')
    ])

    expect(state.items[0]).toMatchObject({ status: 'denied' })
    expect(state.items[1]).toMatchObject({ status: 'error', result: 'boom' })
  })

  test('ignores replayed events so a reconnect cannot duplicate the view', () => {
    const state = createTranscript()
    const first = event({ type: 'user.message', content: [{ type: 'text', text: 'hi' }] })

    applyEvent(state, first)
    applyEvent(state, first)

    expect(state.items).toHaveLength(1)
    expect(state.lastSeq).toBe(first.seq)
  })
})

/**
 * The descriptor is the whole contract between a tool and a renderer. These are the functions the
 * web app decides with, so they are worth pinning without mounting a component.
 */
describe('display descriptors', () => {
  test("interpolates the call's input into the label", () => {
    expect(labelFor({ label: '{path}' }, { path: 'src/app.ts' })).toBe('src/app.ts')
    expect(labelFor({ label: '{pattern}' }, { pattern: 'TODO' })).toBe('TODO')
  })

  test('an alternation takes the first field the call actually set', () => {
    const display = { label: '/{pattern}/ {glob|path}' }

    expect(labelFor(display, { pattern: 'x', glob: '**/*.ts' })).toBe('/x/ **/*.ts')
    expect(labelFor(display, { pattern: 'x', path: 'src' })).toBe('/x/ src')
    expect(labelFor(display, { pattern: 'x' })).toBe('/x/')
  })

  test('a tool with no descriptor still gets a readable header', () => {
    expect(labelFor(undefined, { path: 'a.ts', other: 1 })).toBe('a.ts')
    expect(labelFor(undefined, { count: 3 })).toBe('3')
    expect(labelFor(undefined, 'not an object')).toBe('')
  })

  test('views fall back to what an unknown tool always got: JSON in, text out', () => {
    expect(inputViewOf(undefined)).toBe('json')
    expect(resultViewOf(undefined)).toBe('text')
    expect(inputViewOf({ input: 'diff' })).toBe('diff')
    expect(resultViewOf({ result: 'list' })).toBe('list')
  })

  test('syntax highlighting comes from the input field the tool named', () => {
    expect(languageOfInput({ languageFrom: 'path' }, { path: 'a.ts' })).toBe('typescript')
    expect(languageOfInput({ languageFrom: 'path' }, { path: 'a.unknown' })).toBeUndefined()
    expect(languageOfInput(undefined, { path: 'a.ts' })).toBeUndefined()
  })
})

/**
 * Extension surfaces. A transcript surface is an ordinary item and inherits branch handling; a
 * panel one is kept aside, because a panel is not part of the conversation.
 */
describe('surfaces', () => {
  const view = { kind: 'text', text: 'coverage 91%' } as const

  test('a transcript surface lands in conversation order', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      { type: 'ui.surface', surfaceId: 'coverage', slot: 'transcript', view }
    ])

    expect(visibleItems(state).map((item) => item.kind)).toEqual(['user', 'surface'])
    expect(visiblePanels(state)).toEqual([])
  })

  test('a panel surface stays out of the transcript', () => {
    const state = fold([{ type: 'ui.surface', surfaceId: 'coverage', slot: 'panel', view }])

    expect(visibleItems(state)).toEqual([])
    expect(visiblePanels(state).map((panel) => panel.surfaceId)).toEqual(['coverage'])
  })

  test('writing the same id again replaces it rather than stacking copies', () => {
    const state = fold([
      { type: 'ui.surface', surfaceId: 'coverage', slot: 'panel', view },
      {
        type: 'ui.surface',
        surfaceId: 'coverage',
        slot: 'panel',
        view: { kind: 'text', text: '94%' }
      }
    ])

    const panels = visiblePanels(state)
    expect(panels).toHaveLength(1)
    expect(panels[0]?.view).toMatchObject({ text: '94%' })
  })

  test('a null view removes it from wherever it was', () => {
    const state = fold([
      { type: 'ui.surface', surfaceId: 'inline', slot: 'transcript', view },
      { type: 'ui.surface', surfaceId: 'aside', slot: 'panel', view },
      { type: 'ui.surface', surfaceId: 'inline', view: null },
      { type: 'ui.surface', surfaceId: 'aside', view: null }
    ])

    expect(visibleItems(state)).toEqual([])
    expect(visiblePanels(state)).toEqual([])
  })

  test('a surface on an abandoned branch is not drawn', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      { type: 'ui.surface', surfaceId: 'coverage', slot: 'panel', view },
      { type: 'session.branched', fromSeq: 1 }
    ])

    // Still in the fold, which is what lets branching back put it on screen again.
    expect(state.items.some((item) => item.kind === 'surface')).toBe(true)
    expect(visiblePanels(state)).toEqual([])
  })
})

describe('notes and the harness plan', () => {
  test('keep the last version of each, outside the conversation', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      {
        type: 'session.notes',
        notes: [{ id: 'n1', text: 'Ask about the API', done: false, author: 'user' }]
      },
      plan('in_progress'),
      plan('completed')
    ])

    expect(state.notes).toEqual([
      { id: 'n1', text: 'Ask about the API', done: false, author: 'user' }
    ])
    expect(state.tasks).toEqual([{ id: '1', text: 'Read', status: 'completed' }])
    // Neither is a step in the conversation, so the head is still the message.
    expect(state.head).toBe(1)
    expect(textsOf(visibleItems(state))).toEqual(['hi'])
  })

  test('survive the harness starting a new conversation', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      {
        type: 'session.notes',
        notes: [{ id: 'n1', text: 'Ask about the API', done: false, author: 'user' }]
      },
      { type: 'session_changed', sessionId: 'h2' }
    ])

    expect(state.notes).toHaveLength(1)
  })
})
