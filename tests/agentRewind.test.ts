// Taking a conversation back to an earlier message, so a sent message can be
// edited and the conversation rerun from it.
//
// The harness has to be taken back to the same place the transcript shows, so
// the cut point is checked against the fold's own idea of the path, and the
// service against a fake harness that records what each run was started with.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientEventBody, ServerEventBody, SessionEvent } from '../src/shared/agents'
import { AgentService } from '../src/main/agents/service'
import { HarnessRegistry, type HarnessRunOptions } from '../src/main/agents/harness'
import { rewindPoint } from '../src/main/agents/rewind'
import { SessionStore } from '../src/main/agents/store'
import {
  applyEvent,
  createTranscript,
  visibleItems
} from '../src/renderer/src/lib/agents/transcript'
import type { TranscriptState, UserItem } from '../src/renderer/src/lib/agents/transcript'
import { canEditMessage, editMessageEvents } from '../src/renderer/src/lib/agents/editMessage'

/** An event body as a test writes it; the log stamps the rest. */
type Body = Record<string, unknown>

/** A log as the store would stamp it, seq from 1. */
function log(bodies: Body[]): SessionEvent[] {
  return bodies.map(
    (body, index) =>
      ({
        ...body,
        id: `e${index + 1}`,
        seq: index + 1,
        sessionId: 's',
        createdAt: ''
      }) as SessionEvent
  )
}

function say(text: string): Body {
  return { type: 'user.message', content: [{ type: 'text', text }] }
}

function reply(text: string, messageId?: string): Body {
  const update: Record<string, unknown> = {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text }
  }
  if (messageId) update.messageId = messageId
  return { type: 'update', update }
}

const idle: Body = { type: 'session.status_idle', stopReason: 'end_turn' }
const running: Body = { type: 'session.status_running' }

describe('rewindPoint', () => {
  test('cuts after the last agent message before the event', () => {
    const events = log([
      say('first'),
      running,
      reply('one', 'm1'),
      idle,
      say('second'),
      running,
      reply('two', 'm2'),
      idle
    ])
    // Editing "second" (seq 5) continues from seq 4.
    expect(rewindPoint(events, 4)).toEqual({ kind: 'message', messageId: 'm1' })
  })

  test('starts over when nothing the agent said comes before it', () => {
    const events = log([
      say('refused'),
      running,
      { type: 'session.notice', message: 'declined', refusal: true },
      idle
    ])
    expect(rewindPoint(events, 0)).toEqual({ kind: 'start' })
  })

  test('follows an earlier rewind rather than the order of the log', () => {
    const events = log([
      say('first'), // 1
      reply('one', 'm1'), // 2
      idle, // 3
      say('abandoned'), // 4
      reply('gone', 'm-gone'), // 5
      idle, // 6
      { type: 'user.branch', fromSeq: 3 }, // 7
      { type: 'session.branched', fromSeq: 3 }, // 8
      say('retry'), // 9
      running, // 10
      { type: 'session.notice', message: 'declined', refusal: true }, // 11
      idle // 12
    ])
    // The abandoned reply sits between in seq, but not on the path.
    expect(rewindPoint(events, 12)).toEqual({ kind: 'message', messageId: 'm1' })
  })

  test('a cleared conversation is where the path ends', () => {
    const events = log([
      say('first'),
      reply('one', 'm1'),
      idle,
      { type: 'session_changed', sessionId: 'new' },
      say('after')
    ])
    expect(rewindPoint(events, 5)).toEqual({ kind: 'start' })
  })

  test('cannot cut at an agent message the harness gave no id', () => {
    const events = log([say('first'), reply('one'), idle])
    expect(rewindPoint(events, 3)).toEqual({ kind: 'unidentified' })
  })

  test('knows no event that is not on the log', () => {
    expect(rewindPoint(log([say('first')]), 7)).toBeNull()
  })
})

describe('editing a message in the transcript', () => {
  test('the edit replaces the message and everything after it, the log keeping them', () => {
    const state = createTranscript()
    const stamped = log([
      say('first'),
      reply('one', 'm1'),
      idle,
      say('refused'),
      { type: 'session.notice', message: 'declined', refusal: true },
      idle
    ])
    for (const event of stamped) applyEvent(state, event)
    const refused = userItem(state, 'refused')

    const events = editMessageEvents(state, refused, 'reworded')
    expect(events[0]).toEqual({ type: 'user.branch', fromSeq: 3 })

    // What the service puts on the log for them.
    const next = log([
      ...stamped,
      events[0],
      { type: 'session.branched', fromSeq: 3 },
      events[1]
    ] as Body[])
    for (const event of next.slice(stamped.length)) applyEvent(state, event)

    const texts = visibleItems(state).map((item) => ('text' in item ? item.text : item.kind))
    expect(texts).toEqual(['first', 'one', 'reworded'])
    expect(state.items.some((item) => item.kind === 'user' && item.text === 'refused')).toBe(true)
  })

  test('a refusal notice is marked as one', () => {
    const state = createTranscript()
    for (const event of log([
      say('x'),
      { type: 'session.notice', message: 'declined', refusal: true }
    ])) {
      applyEvent(state, event)
    }
    expect(visibleItems(state)[1]).toMatchObject({ kind: 'notice', refusal: true })
  })

  test('only an idle session on a harness that rewinds offers the edit', () => {
    const state = createTranscript()
    for (const event of log([say('x'), running])) applyEvent(state, event)
    const item = userItem(state, 'x')
    expect(canEditMessage(item, state, true)).toBe(false)
    applyEvent(state, log([say('x'), running, idle])[2])
    expect(canEditMessage(item, state, false)).toBe(false)
    expect(canEditMessage(item, state, true)).toBe(true)
  })
})

/** The user message on screen that says `text`. */
function userItem(state: TranscriptState, text: string): UserItem {
  for (const item of visibleItems(state)) {
    if (item.kind === 'user' && item.text === text) return item
  }
  throw new Error(`no message "${text}" on screen`)
}

/** A message as the composer sends one. */
function message(text: string): ClientEventBody {
  return { type: 'user.message', content: [{ type: 'text', text }] }
}

class FakeRun {
  prompts: string[] = []
  disposed = 0

  constructor(
    readonly options: HarnessRunOptions,
    readonly resumeKey: string
  ) {}

  prompt(text: string): Promise<void> {
    this.prompts.push(text)
    return Promise.resolve()
  }

  interrupt(): Promise<void> {
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    this.disposed += 1
    return Promise.resolve()
  }

  emit(body: ServerEventBody): void {
    this.options.emit(body)
  }
}

interface Fixture {
  service: AgentService
  store: SessionStore
  runs: FakeRun[]
  cleanup: () => Promise<void>
}

/** A service over a harness that can rewind (`fake`) and one that cannot (`plain`). */
async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'grove-agent-rewind-'))
  const store = new SessionStore(root)
  const harnesses = new HarnessRegistry()
  const runs: FakeRun[] = []
  for (const id of ['fake', 'plain']) {
    harnesses.register({
      id,
      label: id,
      description: '',
      icon: 'grove:test',
      capabilities: {
        approvals: true,
        interrupt: true,
        liveModelSwitch: true,
        thinking: true,
        steering: true,
        groveTools: true,
        groveMode: true,
        attachments: true,
        rewind: id === 'fake'
      },
      probe: () => Promise.resolve({ available: true, detail: null }),
      offering: () =>
        Promise.resolve({ tools: [], commands: [], skills: [], models: [], default: null }),
      start: (options) => {
        // A fork opens a conversation of its own, as switchboard's does.
        const run = new FakeRun(options, `conversation-${runs.length + 1}`)
        runs.push(run)
        return Promise.resolve(run)
      }
    })
  }
  const service = new AgentService({
    store,
    harnesses,
    tools: () => [],
    publish: () => {},
    defaultHarness: () => 'fake'
  })
  return { service, store, runs, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Run a turn on the session's current run: what the user said, answered by the agent. */
async function turn(
  fixture: Fixture,
  sessionId: string,
  text: string,
  messageId: string
): Promise<void> {
  await fixture.service.send(sessionId, [message(text)])
  const run = fixture.runs[fixture.runs.length - 1]
  run.emit({ type: 'session.status_running' })
  run.emit({
    type: 'update',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `re: ${text}` },
      messageId
    }
  })
  run.emit({ type: 'session.status_idle', stopReason: 'end_turn' })
  await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('AgentService rewind', () => {
  test('the next run opens the conversation cut after the last kept agent message', async () => {
    const fixture = await setup()
    try {
      const session = await fixture.service.createSession({ workspace: '/tmp/worktree' })
      await turn(fixture, session.id, 'first', 'm1')
      await turn(fixture, session.id, 'refused', 'm2')
      // Editing "refused": the conversation continues from the event before it.
      const refused = fixture.store
        .peekEvents(session.id)
        .findLast((event) => event.type === 'user.message')
      if (!refused) throw new Error('the message never reached the log')
      const fromSeq = refused.seq - 1

      await fixture.service.send(session.id, [
        { type: 'user.branch', fromSeq },
        message('reworded')
      ])

      expect(fixture.runs).toHaveLength(2)
      expect(fixture.runs[0].disposed).toBe(1)
      expect(fixture.runs[1].options.resumeKey).toBe('conversation-1')
      expect(fixture.runs[1].options.forkAt).toBe('m1')
      expect(fixture.runs[1].prompts).toEqual(['reworded'])
      // The copy is the conversation from now on.
      const stored = await fixture.store.require(session.id)
      expect(stored.resumeKey).toBe('conversation-2')
      expect(stored.forkAt).toBeUndefined()
      const types = fixture.store
        .peekEvents(session.id)
        .slice(-3)
        .map((event) => event.type)
      expect(types).toEqual(['user.branch', 'session.branched', 'user.message'])
    } finally {
      await fixture.cleanup()
    }
  })

  test('taken back to before anything the agent said, the conversation starts over', async () => {
    const fixture = await setup()
    try {
      const session = await fixture.service.createSession({ workspace: '/tmp/worktree' })
      await turn(fixture, session.id, 'refused', 'm1')
      await fixture.service.send(session.id, [
        { type: 'user.branch', fromSeq: 0 },
        message('reworded')
      ])
      expect(fixture.runs[1].options.resumeKey).toBeNull()
      expect(fixture.runs[1].options.forkAt).toBeUndefined()
    } finally {
      await fixture.cleanup()
    }
  })

  test('a harness that cannot rewind refuses, and the edited message is not sent', async () => {
    const fixture = await setup()
    try {
      const session = await fixture.service.createSession({
        workspace: '/tmp/worktree',
        harness: 'plain'
      })
      await turn(fixture, session.id, 'first', 'm1')
      const before = fixture.store.peekEvents(session.id).length
      await expect(
        fixture.service.send(session.id, [{ type: 'user.branch', fromSeq: 0 }, message('reworded')])
      ).rejects.toThrow('cannot take a conversation back')
      expect(fixture.store.peekEvents(session.id)).toHaveLength(before)
      expect(fixture.runs[0].prompts).toEqual(['first'])
    } finally {
      await fixture.cleanup()
    }
  })

  test('a running turn has to be stopped first', async () => {
    const fixture = await setup()
    try {
      const session = await fixture.service.createSession({ workspace: '/tmp/worktree' })
      await fixture.service.send(session.id, [message('first')])
      fixture.runs[0].emit({ type: 'session.status_running' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await expect(
        fixture.service.send(session.id, [{ type: 'user.branch', fromSeq: 0 }])
      ).rejects.toThrow('Stop the agent')
    } finally {
      await fixture.cleanup()
    }
  })
})
