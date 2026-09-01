// The service is the contract every harness is written against: it starts a run
// on first prompt, folds what the run emits onto the log, holds tool calls until
// grove answers them, and queues anything sent while a turn is in flight.
//
// A fake harness stands in for the SDKs so the protocol itself is what is tested
// rather than any one of them.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService } from '../src/main/agents/service'
import { HarnessRegistry, type HarnessRunOptions } from '../src/main/agents/harness'
import { SessionStore } from '../src/main/agents/store'

class FakeRun {
  resumeKey = 'thread-1'
  prompts: string[] = []
  steered: string[] = []
  interrupted = 0
  disposed = 0

  constructor(readonly options: HarnessRunOptions) {}

  async prompt(text: string): Promise<void> {
    this.prompts.push(text)
    this.options.emit({ type: 'session.status_running' })
  }

  async steer(text: string): Promise<void> {
    this.steered.push(text)
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1
  }

  async dispose(): Promise<void> {
    this.disposed += 1
  }

  /** Finish the turn, the way a real harness does when its loop settles. */
  finish(): void {
    this.options.emit({ type: 'session.status_idle', stopReason: 'end_turn' })
  }
}

/** A run that can also take slash commands, which is optional in the contract. */
class CommandRun extends FakeRun {
  commands: string[] = []

  async command(name: string, args: string): Promise<void> {
    this.commands.push(`${name} ${args}`.trim())
  }
}

interface Harness {
  service: AgentService
  store: SessionStore
  runs: FakeRun[]
  cleanup: () => Promise<void>
}

/** Let the service's own promise chains settle before asserting on them. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

async function setup(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'grove-agent-service-'))
  const store = new SessionStore(root)
  const harnesses = new HarnessRegistry()
  const runs: FakeRun[] = []

  // Several of them, so switching harness — and a harness that can run commands
  // against one that cannot — can be tested for what they actually do.
  for (const id of ['fake', 'other', 'commanding']) {
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
        groveTools: true
      },
      probe: async () => ({ available: true, detail: null }),
      offering: async () => ({
        tools: [],
        commands: [],
        skills: [],
        providers: [{ provider: id, models: [{ id: `${id}-model`, provider: id }] }],
        default: { provider: id, model: `${id}-model` }
      }),
      start: async (options) => {
        const run = id === 'commanding' ? new CommandRun(options) : new FakeRun(options)
        runs.push(run)
        return run
      },
      intentOf: () => null
    })
  }

  const service = new AgentService({
    store,
    harnesses,
    tools: () => [],
    publish: () => {},
    defaultHarness: () => 'fake'
  })

  return {
    service,
    store,
    runs,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

function say(text: string): { type: 'user.message'; content: { type: 'text'; text: string }[] } {
  return { type: 'user.message', content: [{ type: 'text', text }] }
}

describe('AgentService', () => {
  test('the first message starts a run on the session harness', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      expect(session.harness).toBe('fake')

      await service.send(session.id, [say('hello')])
      expect(runs).toHaveLength(1)
      expect(runs[0].prompts).toEqual(['hello'])
    } finally {
      await cleanup()
    }
  })

  test('a new session starts on the model its harness recommends', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      expect(session.provider).toBe('fake')
      expect(session.model).toBe('fake-model')
    } finally {
      await cleanup()
    }
  })

  test('an explicitly named model wins over the harness default', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({
        workspace: '/tmp/worktree',
        provider: 'chosen',
        model: 'chosen-model'
      })
      expect(session.provider).toBe('chosen')
      expect(session.model).toBe('chosen-model')
    } finally {
      await cleanup()
    }
  })

  test('the harness-native id is stored so a restart can resume', async () => {
    const { service, store, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('hello')])

      expect((await store.require(session.id)).resumeKey).toBe('thread-1')
    } finally {
      await cleanup()
    }
  })

  test('a steer reaches a running turn, a follow-up waits for the next one', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('first')])

      await service.send(session.id, [{ ...say('urgent'), deliverAs: 'steer' }])
      await service.send(session.id, [{ ...say('later'), deliverAs: 'followUp' }])

      expect(runs[0].steered).toEqual(['urgent'])
      expect(runs[0].prompts).toEqual(['first'])
      expect(service.queueOf(session.id).map((message) => message.text)).toEqual(['later'])

      runs[0].finish()
      await settle()
      expect(runs[0].prompts).toEqual(['first', 'later'])
    } finally {
      await cleanup()
    }
  })

  test('an unqueued message is never delivered', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('first')])
      await service.send(session.id, [{ ...say('later'), deliverAs: 'followUp' }])

      const [queued] = service.queueOf(session.id)
      await service.send(session.id, [{ type: 'user.unqueue', messageId: queued.id }])
      runs[0].finish()
      await settle()

      expect(runs[0].prompts).toEqual(['first'])
    } finally {
      await cleanup()
    }
  })

  test('a tool call parks until it is answered, and is announced as pending', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('go')])

      const confirm = service['requestApproval'](session.id, {
        toolUseId: 'call-1',
        name: 'write',
        input: { path: 'a.ts' }
      })
      const snapshot = await service.getSession(session.id)
      expect(snapshot.pendingApprovals).toEqual(['call-1'])

      await service.send(session.id, [
        { type: 'user.tool_confirmation', toolUseId: 'call-1', result: 'allow' }
      ])
      expect(await confirm).toEqual({ result: 'allow' })
      expect((await service.getSession(session.id)).pendingApprovals).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test('always_session answers the rest of that tool’s calls without asking', async () => {
    const { service, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('go')])

      const first = service['requestApproval'](session.id, {
        toolUseId: 'call-1',
        name: 'write',
        input: {}
      })
      await service.send(session.id, [
        { type: 'user.tool_confirmation', toolUseId: 'call-1', result: 'always_session' }
      ])
      expect(await first).toEqual({ result: 'always_session' })

      const second = await service['requestApproval'](session.id, {
        toolUseId: 'call-2',
        name: 'write',
        input: {}
      })
      expect(second).toEqual({ result: 'allow' })
    } finally {
      await cleanup()
    }
  })

  test('a tool call reaches the log exactly once, whoever reports it', async () => {
    const { service, store, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('go')])

      void service['requestApproval'](session.id, {
        toolUseId: 'call-1',
        name: 'write',
        input: {}
      })
      // The adapter reports the same call again once the model's message lands.
      runs[0].options.emit({
        type: 'agent.tool_use',
        toolUseId: 'call-1',
        name: 'write',
        input: {},
        permission: 'allow'
      })
      await settle()

      const events = await store.eventsSince(session.id, 0)
      const calls = events.filter((event) => event.type === 'agent.tool_use')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ permission: 'ask' })
    } finally {
      await cleanup()
    }
  })

  test('changing harness drops the run and the id that belonged to it', async () => {
    const { service, store, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [say('go')])
      await service.updateSession(session.id, { harness: 'other' })

      expect(runs[0].disposed).toBe(1)
      expect((await store.require(session.id)).resumeKey).toBeNull()
    } finally {
      await cleanup()
    }
  })

  test('a slash command reaches a harness that can run one', async () => {
    const { service, runs, cleanup } = await setup()
    try {
      const session = await service.createSession({
        workspace: '/tmp/worktree',
        harness: 'commanding'
      })
      await service.send(session.id, [{ type: 'user.command', name: 'review', args: 'the diff' }])

      expect((runs[0] as CommandRun).commands).toEqual(['review the diff'])
    } finally {
      await cleanup()
    }
  })

  test('a harness without commands says so instead of dropping the ask', async () => {
    const { service, store, cleanup } = await setup()
    try {
      const session = await service.createSession({ workspace: '/tmp/worktree' })
      await service.send(session.id, [{ type: 'user.command', name: 'review', args: '' }])

      const events = await store.eventsSince(session.id, 0)
      const notice = events.find((event) => event.type === 'session.notice')
      expect(notice).toMatchObject({ message: '"/review" is not supported by this harness' })
    } finally {
      await cleanup()
    }
  })

  test('a session without a workspace is refused', async () => {
    const { service, cleanup } = await setup()
    try {
      await expect(service.createSession({})).rejects.toThrow('a session needs a workspace')
    } finally {
      await cleanup()
    }
  })
})
