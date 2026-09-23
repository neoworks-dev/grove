// An agent a harness runs inside one of its own tool calls.
//
// grove treats it as it treats an agent of its own: a session in the family of
// the one that started it, with its own transcript and its own status. A fake
// harness stands in for the SDKs, because the point is that any harness
// reporting through `emitFrom` gets this — nothing about it is Claude's.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assistantEvents,
  signalsWork,
  streamEvents,
  toolResultEvents
} from '../src/main/agents/harnesses/claude'
import { HarnessRegistry, type HarnessRunOptions } from '../src/main/agents/harness'
import { AgentService } from '../src/main/agents/service'
import { SessionStore } from '../src/main/agents/store'
import { SUBAGENT_LABEL } from '../src/main/agents/subagents'
import { PARENT_LABEL } from '../src/main/agents/handoffBridge'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '../src/shared/agents'

const EXPLORER = { toolUseId: 'toolu_task', title: 'explore', description: 'map the review flow' }

class FakeRun {
  resumeKey = null

  constructor(readonly options: HarnessRunOptions) {}

  async prompt(): Promise<void> {
    this.options.emit({ type: 'session.status_running' })
  }

  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
}

interface Fixture {
  service: AgentService
  store: SessionStore
  runs: FakeRun[]
  cleanup: () => Promise<void>
}

/** Let the service's own promise chains settle before asserting on them. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'grove-subagents-'))
  const store = new SessionStore(root)
  const harnesses = new HarnessRegistry()
  const runs: FakeRun[] = []

  harnesses.register({
    id: 'fake',
    label: 'fake',
    description: '',
    icon: 'grove:test',
    capabilities: {
      approvals: true,
      interrupt: true,
      liveModelSwitch: true,
      thinking: true,
      steering: true,
      groveTools: true
    },
    probe: async () => ({ available: true, detail: null }),
    offering: async () => ({
      tools: [],
      commands: [],
      skills: [],
      models: [
        { key: 'fake-model', label: 'fake-model', routes: [{ provider: 'fake', id: 'fake-model' }] }
      ],
      default: { provider: 'fake', model: 'fake-model' }
    }),
    start: async (options) => {
      const run = new FakeRun(options)
      runs.push(run)
      return run
    },
    intentOf: () => null
  })

  const service = new AgentService({
    store,
    harnesses,
    tools: () => [],
    publish: () => {},
    defaultHarness: () => 'fake'
  })

  return { service, store, runs, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Start a session, get its run going, and hand back both. */
async function running(fixture: Fixture): Promise<{ sessionId: string; run: FakeRun }> {
  const session = await fixture.service.createSession({ workspace: '/tmp/worktree' })
  await fixture.service.send(session.id, [
    { type: 'user.message', content: [{ type: 'text', text: 'go' }] }
  ])
  await settle()
  return { sessionId: session.id, run: fixture.runs[0] }
}

/** Every session the service knows about except the one named. */
async function others(
  fixture: Fixture,
  sessionId: string
): Promise<{ id: string; title: string }[]> {
  const sessions = await fixture.service.listSessions()
  return sessions.filter((session) => session.id !== sessionId)
}

function texts(events: SessionEvent[]): string[] {
  const deltas = events.filter((event) => event.type === 'agent.message_delta')
  return deltas.map((event) => event.text)
}

describe('a harness running its own agent', () => {
  test('its first event opens a session under the one that started it', async () => {
    const fixture = await setup()
    try {
      const { sessionId, run } = await running(fixture)
      run.options.emitFrom(EXPLORER, { type: 'agent.message_delta', text: 'looking' })
      await settle()

      const [child] = await others(fixture, sessionId)
      expect(child.title).toBe('explore')

      const session = await fixture.store.require(child.id)
      expect(session.labels[PARENT_LABEL]).toBe(sessionId)
      expect(session.labels[SUBAGENT_LABEL]).toBe('toolu_task')
      expect(session.workspaceRoot).toBe('/tmp/worktree')
      expect(session.harness).toBe('fake')
    } finally {
      await fixture.cleanup()
    }
  })

  test('the task it was given opens its transcript', async () => {
    const fixture = await setup()
    try {
      const { sessionId, run } = await running(fixture)
      run.options.emitFrom(EXPLORER, { type: 'agent.message_delta', text: 'looking' })
      await settle()

      const [child] = await others(fixture, sessionId)
      const events = await fixture.service.listEvents(child.id)
      expect(events[0].type).toBe('user.message')
      expect(events[1]).toMatchObject({ type: 'agent.message_delta', text: 'looking' })
    } finally {
      await fixture.cleanup()
    }
  })

  test('its work stays out of the conversation that started it', async () => {
    const fixture = await setup()
    try {
      const { sessionId, run } = await running(fixture)
      run.options.emit({ type: 'agent.message_delta', text: 'the answer is ' })
      run.options.emitFrom(EXPLORER, { type: 'agent.message_delta', text: 'still looking' })
      run.options.emit({ type: 'agent.message_delta', text: 'forty-two' })
      await settle()

      expect(texts(await fixture.service.listEvents(sessionId))).toEqual([
        'the answer is ',
        'forty-two'
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  test('two agents in one turn get one session each', async () => {
    const fixture = await setup()
    try {
      const { sessionId, run } = await running(fixture)
      run.options.emitFrom(EXPLORER, { type: 'agent.message_delta', text: 'one' })
      run.options.emitFrom(
        { toolUseId: 'toolu_other', title: 'review' },
        { type: 'agent.message_delta', text: 'two' }
      )
      await settle()

      expect((await others(fixture, sessionId)).map((session) => session.title).sort()).toEqual([
        'explore',
        'review'
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  test('everything it says afterwards lands in the same session', async () => {
    const fixture = await setup()
    try {
      const { sessionId, run } = await running(fixture)
      run.options.emitFrom(EXPLORER, { type: 'agent.message_delta', text: 'one ' })
      await settle()
      run.options.emitFrom(EXPLORER, { type: 'agent.message_delta', text: 'two' })
      await settle()

      const children = await others(fixture, sessionId)
      expect(children).toHaveLength(1)
      expect(texts(await fixture.service.listEvents(children[0].id))).toEqual(['one ', 'two'])
    } finally {
      await fixture.cleanup()
    }
  })

  test('the result of its tool call ends it', async () => {
    const fixture = await setup()
    try {
      const { sessionId, run } = await running(fixture)
      run.options.emitFrom(EXPLORER, { type: 'agent.message_delta', text: 'looking' })
      await settle()
      run.options.emit({
        type: 'agent.tool_result',
        toolUseId: 'toolu_task',
        name: 'Task',
        content: 'here is what I found',
        isError: false
      })
      await settle()

      const [child] = await others(fixture, sessionId)
      expect((await fixture.service.getSession(child.id)).status).toBe('terminated')
    } finally {
      await fixture.cleanup()
    }
  })

  test('it cannot be written to: there is no run behind it', async () => {
    const fixture = await setup()
    try {
      const { sessionId, run } = await running(fixture)
      run.options.emitFrom(EXPLORER, { type: 'agent.message_delta', text: 'looking' })
      await settle()

      const [child] = await others(fixture, sessionId)
      await fixture.service.send(child.id, [
        { type: 'user.message', content: [{ type: 'text', text: 'carry on' }] }
      ])
      await settle()

      expect(fixture.runs).toHaveLength(1)
      const events = await fixture.service.listEvents(child.id)
      expect(events[events.length - 1].type).toBe('session.notice')
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('what a Claude message carries', () => {
  test('an assistant message announces its calls and ends its block', () => {
    const content = [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: 'done' }
    ]

    expect(assistantEvents(content).map((event) => event.type)).toEqual([
      'agent.tool_use',
      'agent.message_end'
    ])
  })

  test('grove knows its own tools by the name it gave them', () => {
    const content = [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__grove__review', input: {} }]

    expect(assistantEvents(content)[0]).toMatchObject({ name: 'review' })
  })

  test('a user message carries what the tools answered', () => {
    const content = [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]

    expect(toolResultEvents(content)).toEqual([
      { type: 'agent.tool_result', toolUseId: 'toolu_1', name: '', content: 'ok', isError: false }
    ])
  })

  test('an image a tool returned is stored and travels as a blob reference', () => {
    const content = [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: 'screenshot taken' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }
        ]
      }
    ]
    const stored: string[] = []

    const events = toolResultEvents(content, (image) => {
      stored.push(`${image.mediaType}:${image.data}`)
      return { type: 'image', ref: 'blob-1', mediaType: image.mediaType }
    })

    expect(stored).toEqual(['image/png:iVBORw0K'])
    expect(events).toEqual([
      {
        type: 'agent.tool_result',
        toolUseId: 'toolu_1',
        name: '',
        content: 'screenshot taken',
        isError: false,
        images: [{ type: 'image', ref: 'blob-1', mediaType: 'image/png' }]
      }
    ])
  })

  test('deltas stream as text and thinking separately', () => {
    const text = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }
    const thinking = {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'hm' }
    }

    expect(streamEvents(text)).toEqual([{ type: 'agent.message_delta', text: 'hello' }])
    expect(streamEvents(thinking)).toEqual([{ type: 'agent.thinking_delta', text: 'hm' }])
  })

  test('anything the model produces means the session is working', () => {
    for (const type of ['stream_event', 'assistant', 'user'] as SDKMessage['type'][]) {
      expect(signalsWork({ type } as SDKMessage)).toBe(true)
    }
    expect(signalsWork({ type: 'result' } as SDKMessage)).toBe(false)
  })
})
