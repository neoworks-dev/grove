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
import { HarnessRegistry, type HarnessRunOptions } from '../src/main/agents/harness'
import { AgentService } from '../src/main/agents/service'
import { SessionStore } from '../src/main/agents/store'
import { SUBAGENT_LABEL } from '../src/main/agents/subagents'
import { PARENT_LABEL } from '../src/main/agents/handoffBridge'
import type { ServerEventBody, SessionEvent } from '../src/shared/agents'

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
    }
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

/** An agent message chunk as switchboard reports one. */
function chunk(text: string): ServerEventBody {
  return { type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }
}

/** The text of every message chunk on a log. */
function texts(events: SessionEvent[]): string[] {
  const found: string[] = []
  for (const event of events) {
    if (event.type !== 'update' || event.update.sessionUpdate !== 'agent_message_chunk') continue
    if (event.update.content.type === 'text') found.push(event.update.content.text)
  }
  return found
}

describe('a harness running its own agent', () => {
  test('its first event opens a session under the one that started it', async () => {
    const fixture = await setup()
    try {
      const { sessionId, run } = await running(fixture)
      run.options.emitFrom(EXPLORER, chunk('looking'))
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
      run.options.emitFrom(EXPLORER, chunk('looking'))
      await settle()

      const [child] = await others(fixture, sessionId)
      const events = await fixture.service.listEvents(child.id)
      expect(events[0].type).toBe('user.message')
      expect(events[1]).toMatchObject(chunk('looking'))
    } finally {
      await fixture.cleanup()
    }
  })

  test('its work stays out of the conversation that started it', async () => {
    const fixture = await setup()
    try {
      const { sessionId, run } = await running(fixture)
      run.options.emit(chunk('the answer is '))
      run.options.emitFrom(EXPLORER, chunk('still looking'))
      run.options.emit(chunk('forty-two'))
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
      run.options.emitFrom(EXPLORER, chunk('one'))
      run.options.emitFrom(
        { toolUseId: 'toolu_other', title: 'review' },
        chunk('two')
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
      run.options.emitFrom(EXPLORER, chunk('one '))
      await settle()
      run.options.emitFrom(EXPLORER, chunk('two'))
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
      run.options.emitFrom(EXPLORER, chunk('looking'))
      await settle()
      run.options.emit({
        type: 'update',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_task', status: 'completed' }
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
      run.options.emitFrom(EXPLORER, chunk('looking'))
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
