// Ported from nib's tests/renderer.test.ts, pointed at grove's vendored copies of
// the fold. It exists to catch a re-vendor that changed behaviour: if these stop
// passing after copying nib's files over, the transcript renders something other
// than what nib intends.

import { describe, expect, test } from 'bun:test'
import {
  applyEvent,
  createTranscript,
  pendingApprovals,
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

describe('transcript fold', () => {
  test('assembles a streamed agent turn', () => {
    const state = fold([
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      { type: 'session.status_running' },
      { type: 'agent.message_start' },
      { type: 'agent.thinking_delta', text: 'hmm' },
      { type: 'agent.message_delta', text: 'he' },
      { type: 'agent.message_delta', text: 'llo' },
      { type: 'agent.message_end', content: [], stopReason: 'end_turn' },
      { type: 'session.status_idle', stopReason: 'end_turn' }
    ])

    expect(state.items).toEqual([
      { kind: 'user', seq: 1, eventId: 'evt_1', text: 'hi', attachments: [] },
      { kind: 'agent', seq: 3, eventId: 'evt_3', thinking: 'hmm', text: 'hello', streaming: false }
    ])
    expect(state.status).toBe('idle')
    expect(state.stopReason).toBe('end_turn')
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

  test('drops an assistant turn that only called tools', () => {
    const state = fold([
      { type: 'agent.message_start' },
      {
        type: 'agent.message_end',
        content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }],
        stopReason: 'tool_use'
      }
    ])

    expect(state.items).toEqual([])
  })

  test("records an edited tool input alongside the model's own", () => {
    const state = fold([
      {
        type: 'agent.tool_use',
        toolUseId: 't1',
        name: 'bash',
        input: { command: 'rm -rf /' },
        permission: 'ask'
      },
      { type: 'agent.tool_use_edited', toolUseId: 't1', name: 'bash', input: { command: 'ls' } }
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
      { type: 'agent.message_start' }, // 2
      { type: 'agent.message_delta', text: 'reply' }, // 3
      { type: 'agent.message_end', content: [], stopReason: 'end_turn' }, // 4
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
      { type: 'agent.message_start' }, // 2
      { type: 'agent.message_delta', text: 'half a thou' }, // 3
      { type: 'session.branched', fromSeq: 1 }, // 4
      { type: 'agent.message_start' }, // 5
      { type: 'agent.message_delta', text: 'a fresh answer' } // 6
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

  test('falls back to assembled blocks when no deltas arrive', () => {
    const state = fold([
      { type: 'agent.message_start' },
      {
        type: 'agent.message_end',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn'
      }
    ])

    expect(state.items[0]).toMatchObject({ kind: 'agent', text: 'done', streaming: false })
  })

  test('tracks a tool call from approval to result', () => {
    const state = fold([
      {
        type: 'agent.tool_use',
        toolUseId: 't1',
        name: 'bash',
        input: { command: 'ls' },
        permission: 'ask'
      },
      { type: 'session.status_idle', stopReason: 'requires_action' }
    ])

    expect(pendingApprovals(state).map((tool) => tool.toolUseId)).toEqual(['t1'])

    applyEvent(state, event({ type: 'user.tool_confirmation', toolUseId: 't1', result: 'allow' }))
    expect(state.items[0]).toMatchObject({ status: 'running' })

    applyEvent(
      state,
      event({
        type: 'agent.tool_result',
        toolUseId: 't1',
        name: 'bash',
        content: 'a\nb',
        isError: false
      })
    )
    expect(state.items[0]).toMatchObject({ status: 'ok', result: 'a\nb' })
    expect(pendingApprovals(state)).toEqual([])
  })

  test('marks a denied tool call and an errored result', () => {
    const state = fold([
      { type: 'agent.tool_use', toolUseId: 't1', name: 'write', input: {}, permission: 'ask' },
      { type: 'user.tool_confirmation', toolUseId: 't1', result: 'deny' },
      { type: 'agent.tool_use', toolUseId: 't2', name: 'read', input: {}, permission: 'allow' },
      { type: 'agent.tool_result', toolUseId: 't2', name: 'read', content: 'boom', isError: true }
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
