// Saying no to a tool call, and stopping a turn that is waiting on one.
//
// A plain deny stops the turn, as Claude Code's "No" does; a deny with a reason
// passes the reason on and lets the agent carry on. A turn the app quit in the
// middle of has no run left to finish it, so it is closed on the next start
// rather than left spinning with a prompt nobody can answer.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService } from '../src/main/agents/service'
import {
  HarnessRegistry,
  type ApprovalDecision,
  type ApprovalRequest,
  type HarnessRunOptions
} from '../src/main/agents/harness'
import { SessionStore } from '../src/main/agents/store'
import { interruptedTurn } from '../src/main/agents/interruptedTurn'
import type { SessionEvent } from '../src/shared/agents'

class FakeRun {
  resumeKey = 'thread-1'
  interrupts = 0

  constructor(readonly options: HarnessRunOptions) {}

  async prompt(): Promise<void> {
    this.options.emit({ type: 'session.status_running' })
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1
  }

  async dispose(): Promise<void> {}

  /** Ask grove whether a call may run, the way a real adapter does. */
  ask(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.options.confirm(request)
  }
}

interface Fixture {
  service: AgentService
  store: SessionStore
  runs: FakeRun[]
}

/** A service over a session store in `root`, with a fake harness that records its runs. */
function serviceAt(root: string): Fixture {
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
      liveModelSwitch: false,
      thinking: false,
      steering: false,
      groveTools: false,
      attachments: false
    },
    probe: async () => ({ available: true, detail: null }),
    offering: async () => ({
      tools: [],
      commands: [],
      skills: [],
      models: [{ key: 'fake-model', label: 'fake-model', routes: [{ provider: 'fake', id: 'm' }] }],
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
  return { service, store, runs }
}

/** Starts a turn and parks a bash call on its approval. */
async function parkedCall(
  fixture: Fixture
): Promise<{ run: FakeRun; sessionId: string; decision: Promise<ApprovalDecision> }> {
  const session = await fixture.service.createSession({ workspace: '/tmp/worktree' })
  await fixture.service.send(session.id, [
    { type: 'user.message', content: [{ type: 'text', text: 'go' }] }
  ])
  const run = fixture.runs[fixture.runs.length - 1]
  const decision = run.ask({ toolUseId: 'call-1', name: 'bash', input: { command: 'ls' } })
  return { run, sessionId: session.id, decision }
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'grove-agent-deny-'))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('denying a call', () => {
  test('a plain deny stops the turn', async () => {
    await withRoot(async (root) => {
      const fixture = serviceAt(root)
      const { run, sessionId, decision } = await parkedCall(fixture)

      await fixture.service.send(sessionId, [
        { type: 'user.tool_confirmation', toolUseId: 'call-1', result: 'deny' }
      ])

      expect((await decision).result).toBe('deny')
      expect(run.interrupts).toBe(1)
    })
  })

  test('a deny with a reason hands the reason over and lets the agent go on', async () => {
    await withRoot(async (root) => {
      const fixture = serviceAt(root)
      const { run, sessionId, decision } = await parkedCall(fixture)

      await fixture.service.send(sessionId, [
        {
          type: 'user.tool_confirmation',
          toolUseId: 'call-1',
          result: 'deny',
          reason: 'use rg instead'
        }
      ])

      expect(await decision).toMatchObject({ result: 'deny', reason: 'use rg instead' })
      expect(run.interrupts).toBe(0)
    })
  })
})

describe('stopping a turn', () => {
  test('denies the call it is waiting on, so its card closes', async () => {
    await withRoot(async (root) => {
      const fixture = serviceAt(root)
      const { run, sessionId, decision } = await parkedCall(fixture)

      await fixture.service.send(sessionId, [{ type: 'user.interrupt' }])

      expect((await decision).result).toBe('deny')
      expect(run.interrupts).toBe(1)
      const events = await fixture.service.listEvents(sessionId)
      expect(events.some((event) => event.type === 'user.tool_confirmation')).toBe(true)
    })
  })
})

describe('a turn the app restarted in the middle of', () => {
  /** A session left running with a call parked, then the service started over the same store. */
  async function restartedMidTurn(root: string): Promise<{ restarted: Fixture; sessionId: string }> {
    const before = serviceAt(root)
    const { sessionId } = await parkedCall(before)
    await before.store.flush()
    return { restarted: serviceAt(root), sessionId }
  }

  test('is closed at startup, with the open call marked as never run', async () => {
    await withRoot(async (root) => {
      const { restarted, sessionId } = await restartedMidTurn(root)

      await restarted.service.settleInterruptedTurns()

      const events = await restarted.service.listEvents(sessionId)
      const result = events.find((event) => event.type === 'agent.tool_result')
      expect(result).toMatchObject({ toolUseId: 'call-1', isError: true })
      expect(events.at(-1)).toMatchObject({ type: 'session.status_idle', stopReason: 'aborted' })
      expect(interruptedTurn(events)).toBeNull()
    })
  })

  test('answering its stale prompt closes it instead of doing nothing', async () => {
    await withRoot(async (root) => {
      const { restarted, sessionId } = await restartedMidTurn(root)

      await restarted.service.send(sessionId, [
        { type: 'user.tool_confirmation', toolUseId: 'call-1', result: 'deny' }
      ])

      expect(interruptedTurn(await restarted.service.listEvents(sessionId))).toBeNull()
    })
  })

  test('stopping it closes it instead of saying nothing is running', async () => {
    await withRoot(async (root) => {
      const { restarted, sessionId } = await restartedMidTurn(root)

      await restarted.service.send(sessionId, [{ type: 'user.interrupt' }])

      const events = await restarted.service.listEvents(sessionId)
      expect(interruptedTurn(events)).toBeNull()
      const notices = events.filter((event) => event.type === 'session.notice')
      expect(notices.some((event) => 'message' in event && /Nothing to stop/.test(event.message))).toBe(false)
    })
  })
})

describe('interruptedTurn', () => {
  /** A log from bodies, stamped the way the store would. */
  function log(...bodies: object[]): SessionEvent[] {
    return bodies.map(
      (body, index) =>
        ({ ...body, id: `e${index}`, seq: index + 1, sessionId: 's', createdAt: '' }) as SessionEvent
    )
  }

  test('is null once the last turn ended, whatever an earlier turn left open', () => {
    const events = log(
      { type: 'session.status_running' },
      { type: 'agent.tool_use', toolUseId: 'a', name: 'bash', input: {}, permission: 'ask' },
      { type: 'session.status_idle', stopReason: 'end_turn' }
    )
    expect(interruptedTurn(events)).toBeNull()
  })

  test('lists the calls still open, leaving out answered and denied ones', () => {
    const events = log(
      { type: 'session.status_running' },
      { type: 'agent.tool_use', toolUseId: 'done', name: 'read', input: {}, permission: 'allow' },
      { type: 'agent.tool_result', toolUseId: 'done', name: 'read', content: '', isError: false },
      { type: 'agent.tool_use', toolUseId: 'denied', name: 'bash', input: {}, permission: 'ask' },
      { type: 'user.tool_confirmation', toolUseId: 'denied', result: 'deny' },
      { type: 'agent.tool_use', toolUseId: 'open', name: 'bash', input: {}, permission: 'ask' }
    )
    expect(interruptedTurn(events)).toEqual([{ toolUseId: 'open', name: 'bash' }])
  })
})
