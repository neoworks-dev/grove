// Permission modes, on both sides of the IPC boundary.
//
// The mode is stored on the session and enforced in the main process, so the
// two halves are tested where they actually live: the picker's reading of a
// session here, and what the service does with a tool call below.
//
// The service half is the one that matters. Accept-edits used to be held in the
// renderer, which meant the main process gated the write anyway and raised the
// review the mode exists to skip — a bug no test of the picker could have seen.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService } from '../src/main/agents/service'
import {
  HarnessRegistry,
  type ApprovalDecision,
  type ApprovalRequest,
  type HarnessRunOptions,
  type ToolIntent
} from '../src/main/agents/harness'
import { SessionStore } from '../src/main/agents/store'
import { modeOf, nextMode, MODE_ORDER } from '../src/renderer/src/lib/agents/modes'
import type { AgentMode, SessionSnapshot } from '../src/renderer/src/lib/agents/types'

// ── The picker's half ───────────────────────────────────────────────

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1',
    title: 'Session',
    workspaceRoot: '/repo',
    harness: 'fake',
    provider: 'anthropic',
    model: 'claude',
    thinkingLevel: 'high',
    activeTools: null,
    autoApproveTools: [],
    permissionMode: 'default',
    labels: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    pendingApprovals: [],
    messageCount: 0,
    lastSeq: 0,
    live: false,
    started: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: 0,
    context: { usedTokens: 0, contextWindow: 200_000, remainingTokens: 200_000, ratio: 0 },
    queued: [],
    ...overrides
  }
}

describe('modeOf', () => {
  test('reads the mode the session stores', () => {
    for (const mode of MODE_ORDER) {
      expect(modeOf(snapshot({ permissionMode: mode }))).toBe(mode)
    }
  })

  test('a session that has not loaded yet is default rather than undefined', () => {
    expect(modeOf(null)).toBe('default')
  })

  test('a session stored before modes were kept on it reads as default', () => {
    const legacy = snapshot()
    delete (legacy as Partial<SessionSnapshot>).permissionMode
    expect(modeOf(legacy)).toBe('default')
  })
})

describe('nextMode', () => {
  test('steps through every mode and comes back round', () => {
    const seen: AgentMode[] = []
    let mode: AgentMode = 'default'
    for (let step = 0; step < MODE_ORDER.length; step += 1) {
      seen.push(mode)
      mode = nextMode(mode)
    }
    expect(seen).toEqual(MODE_ORDER)
    expect(mode).toBe('default')
  })
})

// ── The service's half ──────────────────────────────────────────────

class FakeRun {
  resumeKey = 'thread-1'
  modes: AgentMode[] = []

  constructor(readonly options: HarnessRunOptions) {}

  async prompt(): Promise<void> {
    this.options.emit({ type: 'session.status_running' })
  }

  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}

  async setPermissionMode(mode: AgentMode): Promise<void> {
    this.modes.push(mode)
  }

  /** Ask grove whether a call may run, the way a real adapter does. */
  ask(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.options.confirm(request)
  }
}

interface Fixture {
  service: AgentService
  store: SessionStore
  runs: FakeRun[]
  cleanup: () => Promise<void>
}

/** `write_file` writes; everything else is an ordinary call. */
function intentOf(name: string, input: Record<string, unknown>): ToolIntent | null {
  if (name !== 'write_file') return null
  return {
    kind: 'write',
    path: String(input.path ?? 'file.txt'),
    apply: () => String(input.text ?? '')
  }
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'grove-agent-modes-'))
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
      groveTools: true,
      attachments: true
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
    intentOf
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

/** Start a session in a mode and get its run going, so it can ask about a call. */
async function runningIn(fixture: Fixture, mode: AgentMode): Promise<FakeRun> {
  const session = await fixture.service.createSession({ workspace: '/tmp/worktree' })
  await fixture.service.updateSession(session.id, { permissionMode: mode })
  await fixture.service.send(session.id, [
    { type: 'user.message', content: [{ type: 'text', text: 'go' }] }
  ])
  return fixture.runs[fixture.runs.length - 1]
}

function call(name: string): ApprovalRequest {
  return { toolUseId: `call-${name}`, name, input: { path: 'a.txt', text: 'hi' } }
}

/** Whether an approval was answered without anyone being asked. */
function answeredWithout(decision: Promise<ApprovalDecision>): Promise<boolean> {
  return Promise.race([
    decision.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30))
  ])
}

describe('permission modes, as the service enforces them', () => {
  test('accept-edits lets a write through without asking', async () => {
    const fixture = await setup()
    try {
      const run = await runningIn(fixture, 'acceptEdits')
      const decision = run.ask(call('write_file'))
      expect(await answeredWithout(decision)).toBe(true)
      expect((await decision).result).toBe('allow')
    } finally {
      await fixture.cleanup()
    }
  })

  test('accept-edits still asks about a command', async () => {
    const fixture = await setup()
    try {
      const run = await runningIn(fixture, 'acceptEdits')
      expect(await answeredWithout(run.ask(call('bash')))).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  test('bypass answers everything, commands included', async () => {
    const fixture = await setup()
    try {
      const run = await runningIn(fixture, 'bypass')
      expect(await answeredWithout(run.ask(call('bash')))).toBe(true)
      expect(await answeredWithout(run.ask(call('write_file')))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test('the default mode puts even a write to the user', async () => {
    const fixture = await setup()
    try {
      const run = await runningIn(fixture, 'default')
      expect(await answeredWithout(run.ask(call('write_file')))).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  test('an auto-approved call is logged as allowed, so the review flow lets it be', async () => {
    const fixture = await setup()
    try {
      const run = await runningIn(fixture, 'acceptEdits')
      await run.ask(call('write_file'))

      const events = await fixture.service.listEvents(run.options.sessionId)
      const toolUse = events.find((event) => event.type === 'agent.tool_use')
      // The review bridge only gates calls logged as "ask"; this is what keeps
      // accept-edits from raising the diff it exists to skip.
      expect(toolUse).toBeDefined()
      expect(toolUse && 'permission' in toolUse && toolUse.permission).toBe('allow')
    } finally {
      await fixture.cleanup()
    }
  })

  test('the mode outlives the window that set it', async () => {
    const fixture = await setup()
    try {
      const session = await fixture.service.createSession({ workspace: '/tmp/worktree' })
      await fixture.service.updateSession(session.id, { permissionMode: 'acceptEdits' })

      expect((await fixture.store.require(session.id)).permissionMode).toBe('acceptEdits')
    } finally {
      await fixture.cleanup()
    }
  })

  test('switching mode on a live run tells the harness, for the modes it owns', async () => {
    const fixture = await setup()
    try {
      const run = await runningIn(fixture, 'default')
      await fixture.service.updateSession(run.options.sessionId, { permissionMode: 'plan' })

      expect(run.modes).toEqual(['plan'])
    } finally {
      await fixture.cleanup()
    }
  })
})
