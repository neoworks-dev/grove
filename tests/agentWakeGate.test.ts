// An agent's message to a session asleep past its prompt cache waits for the
// user instead of waking it. What matters: such a message never starts a turn
// on its own, a recent or working session still gets it straight away, each
// of the user's answers does what it says exactly once, and the sender is told
// without being woken for it.

import { describe, expect, test } from 'bun:test'
import { idleSinceOf, pendingHeldMessages, sleepingSince, wakeCostOf } from '../src/main/agents/heldMessages'
import { WakeGate } from '../src/main/agents/wakeGate'
import { AgentRoster } from '../src/main/agents/roster'
import { chatTools } from '../src/main/agents/tools/chatTools'
import { AGENT_ID_LABEL } from '../src/main/agents/identity'
import { applyEvent, createTranscript } from '../src/renderer/src/lib/agents/transcript'
import { foldAttention, type SessionAttention } from '../src/renderer/src/lib/agents/attention'
import { elapsed, tokenCount, wakeSummary } from '../src/renderer/src/lib/agents/heldMessages'
import type { GroveToolContext } from '../src/main/agents/harness'
import type {
  ClientEventBody,
  HeldMessage,
  SessionEvent,
  SessionMeta,
  SessionSnapshot
} from '../src/shared/agents'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-10-07T12:00:00.000Z')

function at(msBeforeNow: number): string {
  return new Date(NOW - msBeforeNow).toISOString()
}

function sessionMeta(id: string, title: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title,
    workspaceRoot: '/repo',
    harness: 'claude',
    provider: 'anthropic',
    model: 'claude-opus',
    thinkingLevel: 'off',
    activeTools: null,
    autoApproveTools: [],
    permissionMode: 'default',
    groveMode: false,
    labels: { [AGENT_ID_LABEL]: `id-${id}` },
    createdAt: at(10 * HOUR),
    updatedAt: at(10 * HOUR),
    status: 'idle',
    pendingApprovals: [],
    heldMessages: [],
    lastSeq: 0,
    live: false,
    started: true,
    preview: null,
    ...overrides
  }
}

/**
 * A service over fixed sessions whose logs grow as events are sent, and a
 * store that hands appended events to its subscribers, as the real ones do.
 */
function fakeService(sessions: SessionMeta[]): {
  agents: ConstructorParameters<typeof WakeGate>[0]['agents']
  store: ConstructorParameters<typeof WakeGate>[0]['store']
  logs: Record<string, SessionEvent[]>
  sent: { sessionId: string; event: ClientEventBody }[]
  finishTurn: (sessionId: string, msBeforeNow: number) => void
  settled: () => Promise<void>
} {
  const logs: Record<string, SessionEvent[]> = {}
  const sent: { sessionId: string; event: ClientEventBody }[] = []
  const listeners = new Set<(event: SessionEvent) => void>()
  const pending: Promise<unknown>[] = []

  function append(sessionId: string, body: object, createdAt = new Date(NOW).toISOString()): void {
    const log = (logs[sessionId] ??= [])
    const event = { ...body, id: `e${log.length + 1}`, seq: log.length + 1, sessionId, createdAt } as SessionEvent
    log.push(event)
    for (const listener of listeners) listener(event)
  }

  const agents = {
    listSessions: () => Promise.resolve(sessions),
    listEvents: (sessionId: string) => Promise.resolve([...(logs[sessionId] ?? [])]),
    getSession: (sessionId: string) =>
      Promise.resolve({
        ...sessions.find((session) => session.id === sessionId),
        context: { usedTokens: 200_000, contextWindow: 1_000_000, remainingTokens: 800_000, ratio: 0.2 }
      } as SessionSnapshot),
    send: (sessionId: string, events: ClientEventBody[]) => {
      for (const event of events) {
        sent.push({ sessionId, event })
        append(sessionId, event)
      }
      return Promise.resolve({ lastSeq: logs[sessionId]?.length ?? 0 })
    },
    catalog: (harness: string) =>
      Promise.resolve({
        harness,
        tools: [],
        commands: [{ name: 'compact', description: 'Compact the conversation', kind: 'builtin' }],
        skills: [],
        models: [],
        default: null
      })
  } as unknown as ConstructorParameters<typeof WakeGate>[0]['agents']

  const store = {
    subscribe: (listener: (event: SessionEvent) => void) => {
      // The gate acts asynchronously; collect what it starts so a test can wait for it.
      const tracked = (event: SessionEvent): void => {
        pending.push(Promise.resolve().then(() => listener(event)))
      }
      listeners.add(tracked)
      return () => listeners.delete(tracked)
    }
  }

  return {
    agents,
    store,
    logs,
    sent,
    finishTurn: (sessionId, msBeforeNow) =>
      append(sessionId, { type: 'session.status_idle', stopReason: 'end_turn' }, at(msBeforeNow)),
    settled: async () => {
      for (let round = 0; round < 5; round += 1) await Promise.all(pending.splice(0))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

function gateOver(service: ReturnType<typeof fakeService>): WakeGate {
  const gate = new WakeGate({
    agents: service.agents,
    store: service.store,
    pricing: () => Promise.resolve({ input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }),
    log: (line) => {
      throw new Error(line)
    },
    now: () => NOW
  })
  gate.watch()
  return gate
}

/** What reached the session as messages for its model, as opposed to what was only recorded. */
function delivered(service: ReturnType<typeof fakeService>, sessionId: string): ClientEventBody[] {
  return service.sent
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.event)
    .filter((event) => event.type === 'app.message' || event.type === 'user.command')
}

function heldOn(service: ReturnType<typeof fakeService>, sessionId: string): HeldMessage {
  const [held] = pendingHeldMessages(service.logs[sessionId] ?? [])
  if (!held) throw new Error(`nothing held on ${sessionId}`)
  return held
}

describe('when a message waits', () => {
  test('a session idle past an hour is asleep from the end of its last turn', () => {
    const events = [
      { type: 'session.status_running', createdAt: at(3 * HOUR) },
      { type: 'session.status_idle', createdAt: at(2 * HOUR) },
      { type: 'session.notes', createdAt: at(1000) }
    ] as SessionEvent[]
    expect(sleepingSince({ status: 'idle', started: true }, events, NOW)).toBe(at(2 * HOUR))
  })

  test('a recent, working, or never-started session is woken freely', () => {
    const recent = [{ type: 'session.status_idle', createdAt: at(30 * 60 * 1000) }] as SessionEvent[]
    const old = [{ type: 'session.status_idle', createdAt: at(2 * HOUR) }] as SessionEvent[]
    expect(sleepingSince({ status: 'idle', started: true }, recent, NOW)).toBeNull()
    expect(sleepingSince({ status: 'running', started: true }, old, NOW)).toBeNull()
    expect(sleepingSince({ status: 'idle', started: false }, old, NOW)).toBeNull()
    const resumed = [...old, { type: 'session.status_running', createdAt: at(1000) }] as SessionEvent[]
    expect(idleSinceOf(resumed)).toBeNull()
  })

  test('waking costs the context at the cache-write rate', () => {
    expect(wakeCostOf(200_000, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 })).toBe(3.75)
    expect(wakeCostOf(200_000, { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 })).toBe(0.6)
    expect(wakeCostOf(200_000, null)).toBeNull()
  })
})

describe('the wake gate', () => {
  test('holds a message to a session asleep for days instead of starting a turn', async () => {
    const service = fakeService([sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')])
    service.finishTurn('b', 3 * 24 * HOUR)
    const roster = new AgentRoster({ agents: service.agents as never, harnesses: {} as never, gate: gateOver(service) })

    const outcome = await roster.deliver('b', 'Planner (id-a)', 'take the parser', 'a')

    expect(outcome).toEqual({ kind: 'held', idleSince: at(3 * 24 * HOUR) })
    expect(delivered(service, 'b')).toEqual([])
    expect(heldOn(service, 'b')).toMatchObject({
      from: 'Planner (id-a)',
      fromSessionId: 'a',
      text: 'take the parser',
      contextTokens: 200_000,
      wakeCost: 3.75,
      canCompact: true
    })
  })

  test('still steers a message straight into a session that ran recently', async () => {
    const service = fakeService([sessionMeta('b', 'Builder')])
    service.finishTurn('b', 10 * 60 * 1000)
    const outcome = await gateOver(service).deliver('b', 'Planner (id-a)', 'take the parser', 'a')

    expect(outcome).toEqual({ kind: 'delivered' })
    expect(delivered(service, 'b')).toEqual([
      { type: 'app.message', label: 'Agent message', from: 'Planner (id-a)', text: 'take the parser', deliverAs: 'steer' }
    ])
  })

  test('sends a held message once the user says so, and only once', async () => {
    const service = fakeService([sessionMeta('a', 'Planner', { status: 'running' }), sessionMeta('b', 'Builder')])
    service.finishTurn('b', 2 * HOUR)
    const gate = gateOver(service)
    await gate.deliver('b', 'Planner (id-a)', 'take the parser', 'a')
    const { heldId } = heldOn(service, 'b')

    await service.agents.send('b', [{ type: 'user.decide_held_message', heldId, decision: 'send' }])
    await service.agents.send('b', [{ type: 'user.decide_held_message', heldId, decision: 'send' }])
    await service.settled()

    expect(delivered(service, 'b')).toEqual([
      { type: 'app.message', label: 'Agent message', from: 'Planner (id-a)', text: 'take the parser', deliverAs: 'steer' }
    ])
    expect(pendingHeldMessages(service.logs.b)).toEqual([])
    // The sender is working, so it hears how the user decided.
    expect(delivered(service, 'a')).toEqual([
      {
        type: 'app.message',
        label: 'Held message',
        text: 'The user delivered your message to Builder (id-b).',
        deliverAs: 'followUp'
      }
    ])
  })

  test('compacts first and has the message follow the compaction', async () => {
    const service = fakeService([sessionMeta('b', 'Builder')])
    service.finishTurn('b', 2 * HOUR)
    await gateOver(service).deliver('b', 'Planner (id-a)', 'take the parser', null)
    const { heldId } = heldOn(service, 'b')

    await service.agents.send('b', [{ type: 'user.decide_held_message', heldId, decision: 'compact_then_send' }])
    await service.settled()

    expect(delivered(service, 'b')).toEqual([
      { type: 'user.command', name: 'compact', args: '' },
      {
        type: 'app.message',
        label: 'Agent message',
        from: 'Planner (id-a)',
        text: 'take the parser',
        deliverAs: 'followUp'
      }
    ])
  })

  test('drops a rejected message and leaves a sender that has gone to sleep asleep', async () => {
    const service = fakeService([sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')])
    service.finishTurn('a', 5 * HOUR)
    service.finishTurn('b', 2 * HOUR)
    await gateOver(service).deliver('b', 'Planner (id-a)', 'take the parser', 'a')
    const { heldId } = heldOn(service, 'b')

    await service.agents.send('b', [{ type: 'user.decide_held_message', heldId, decision: 'reject' }])
    await service.settled()

    expect(delivered(service, 'b')).toEqual([])
    expect(delivered(service, 'a')).toEqual([])
  })

  test('send_message tells the sender its message is held, not delivered', async () => {
    const service = fakeService([sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')])
    service.finishTurn('b', 26 * HOUR)
    const roster = new AgentRoster({ agents: service.agents as never, harnesses: {} as never, gate: gateOver(service) })
    const chat = { post: () => Promise.resolve(), list: () => Promise.resolve([]) }
    const tool = chatTools({ chat: chat as never, roster }).find((entry) => entry.name === 'send_message')
    const context = { sessionId: 'a', workspaceRoot: '/repo', surface: () => {}, show: () => {} } as GroveToolContext

    if (!tool) throw new Error('send_message is missing')
    const result = await tool.execute({ to: 'id-b', text: 'take the parser' }, context)

    expect(result.content).toStartWith('Held, not delivered: Builder (id-b) has been idle since')
    expect(delivered(service, 'b')).toEqual([])
  })
})

describe('the pane and the sidebar', () => {
  const held: HeldMessage = {
    heldId: 'h1',
    from: 'Planner (id-a)',
    fromSessionId: 'a',
    text: 'take the parser',
    idleSince: at(3 * 24 * HOUR),
    contextTokens: 182_000,
    wakeCost: 3.41,
    canCompact: true
  }
  const heldEvent = { type: 'app.held_message', ...held, id: 'e1', seq: 1, sessionId: 'b', createdAt: at(0) } as SessionEvent
  const decision = {
    type: 'user.decide_held_message',
    heldId: 'h1',
    decision: 'reject',
    id: 'e2',
    seq: 2,
    sessionId: 'b',
    createdAt: at(0)
  } as SessionEvent

  test('a held message waits above the composer until decided, outside the conversation', () => {
    const transcript = createTranscript()
    applyEvent(transcript, heldEvent)
    expect(transcript.held).toEqual([held])
    expect(transcript.items).toEqual([])

    applyEvent(transcript, decision)
    expect(transcript.held).toEqual([])
  })

  test('flags the session as needing you until the message is decided', () => {
    const parked = new Set<string>()
    let flag: SessionAttention | undefined = foldAttention(undefined, parked, heldEvent)
    expect(flag).toBe('needs_you')
    flag = foldAttention(flag, parked, decision)
    expect(flag).toBeUndefined()
  })

  test('says how long the session slept and what waking it costs', () => {
    expect(wakeSummary(held, NOW)).toBe(
      'Idle for 3 days, so its cache is cold. Sending this re-reads 182k tokens of context, about $3.41.'
    )
    expect(elapsed(NOW - 90 * 60 * 1000, NOW)).toBe('1 hour')
    expect(tokenCount(1_200_000)).toBe('1.2M')
  })
})
