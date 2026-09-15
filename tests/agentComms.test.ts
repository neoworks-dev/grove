// Agents talking to each other: the tools, the roster they address each other
// through, and the hand-off a spawned agent makes when its turn ends.
//
// The rules that matter are the ones a model can get wrong: a message must reach
// the named agent rather than only the log, an unknown name must come back as an
// error listing who does exist, and only starting another agent may stop a turn
// on an approval.

import { describe, expect, test } from 'bun:test'
import { groveTools } from '../src/main/agents/tools'
import { AgentRoster, type AgentPeer } from '../src/main/agents/roster'
import { AgentHandoffBridge, PARENT_LABEL } from '../src/main/agents/handoffBridge'
import { AGENT_ID_LABEL } from '../src/main/agents/identity'
import { groveSystemPrompt } from '../src/main/agents/systemPrompt'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import type { SessionEvent, SessionMeta } from '../src/shared/agents'

interface Posted {
  from: string
  text: string
  to: string | undefined
}

interface Delivered {
  sessionId: string
  from: string
  text: string
}

function sessionMeta(id: string, title: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title,
    workspaceRoot: '/repo',
    harness: 'claude',
    provider: 'anthropic',
    model: 'opus',
    thinkingLevel: 'off',
    activeTools: null,
    autoApproveTools: [],
    labels: { [AGENT_ID_LABEL]: `id-${id}` },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    pendingApprovals: [],
    lastSeq: 0,
    live: true,
    ...overrides
  }
}

/** A roster over a fixed session list, recording what it was asked to deliver. */
function testRoster(sessions: SessionMeta[]): {
  roster: AgentRoster
  delivered: Delivered[]
  created: { title: string; labels: Record<string, string> | undefined }[]
} {
  const delivered: Delivered[] = []
  const created: { title: string; labels: Record<string, string> | undefined }[] = []
  const agents = {
    listSessions: () => Promise.resolve(sessions),
    createSession: (options: { title?: string; labels?: Record<string, string> }) => {
      created.push({ title: options.title ?? '', labels: options.labels })
      const spawned = sessionMeta('spawned', options.title ?? '', {
        labels: { [AGENT_ID_LABEL]: 'id-spawned', ...options.labels }
      })
      sessions.push(spawned)
      return Promise.resolve({ ...spawned, messageCount: 0 })
    },
    send: (
      sessionId: string,
      events: { type: string; label?: string; from?: string; text?: string }[]
    ) => {
      for (const event of events) {
        if (event.type !== 'app.message') continue
        delivered.push({ sessionId, from: event.from ?? '', text: event.text ?? '' })
      }
      return Promise.resolve({ lastSeq: 0 })
    }
  }
  const harnesses = { ids: () => ['claude', 'pi'] }
  const roster = new AgentRoster({ agents: agents as never, harnesses: harnesses as never })
  return { roster, delivered, created }
}

function toolNamed(name: string, roster: AgentRoster, posted: Posted[]): GroveTool {
  const chat = {
    post: (_root: string, from: { name: string }, text: string, to?: string) => {
      posted.push({ from: from.name, text, to })
      return Promise.resolve()
    },
    list: () => Promise.resolve([])
  }
  const tool = groveTools({ chat: chat as never, roster }).find((entry) => entry.name === name)
  if (!tool) throw new Error(`${name} is not offered`)
  return tool
}

function context(sessionId: string): GroveToolContext {
  return { sessionId, workspaceRoot: '/repo', surface: () => {}, openFiles: () => {} }
}

describe('addressing another agent', () => {
  test('a named message is delivered into that agent, not just logged', async () => {
    const sessions = [sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')]
    const { roster, delivered } = testRoster(sessions)
    const posted: Posted[] = []

    const result = await toolNamed('send_message', roster, posted).execute(
      { to: 'id-b', text: 'take the parser' },
      context('a')
    )

    expect(delivered).toEqual([{ sessionId: 'b', from: 'Planner (id-a)', text: 'take the parser' }])
    expect(posted).toEqual([
      { from: 'Planner (id-a)', text: 'take the parser', to: 'Builder (id-b)' }
    ])
    expect(result.content).toContain('id-b')
  })

  test('a message with no addressee reaches the channel and nobody in particular', async () => {
    const sessions = [sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')]
    const { roster, delivered } = testRoster(sessions)
    const posted: Posted[] = []

    await toolNamed('send_message', roster, posted).execute({ text: 'starting' }, context('a'))

    expect(delivered).toEqual([])
    expect(posted[0].to).toBeUndefined()
  })

  test('an unknown name comes back as an error naming who is here', async () => {
    const sessions = [sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')]
    const { roster, delivered } = testRoster(sessions)
    const posted: Posted[] = []

    const result = await toolNamed('send_message', roster, posted).execute(
      { to: 'Nobody', text: 'hello' },
      context('a')
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Builder')
    expect(delivered).toEqual([])
    expect(posted).toEqual([])
  })

  test('a title is accepted as an address only while it names one session', async () => {
    const sessions = [sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')]
    const { roster } = testRoster(sessions)

    const unique = await roster.resolve('/repo', 'Builder')
    expect(unique?.sessionId).toBe('b')

    sessions.push(sessionMeta('c', 'Builder'))
    expect(await roster.resolve('/repo', 'Builder')).toBeNull()
    expect((await roster.resolve('/repo', 'id-c'))?.sessionId).toBe('c')
  })

  test('an address survives the session being renamed', async () => {
    const sessions = [sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')]
    const { roster } = testRoster(sessions)

    sessions[1] = sessionMeta('b', 'Something else entirely')

    expect((await roster.resolve('/repo', 'id-b'))?.sessionId).toBe('b')
  })
})

describe('the roster an agent reads', () => {
  test('says who is held on a permission request, not just who is busy', async () => {
    const sessions = [
      sessionMeta('a', 'Planner'),
      sessionMeta('b', 'Builder', { status: 'running', pendingApprovals: ['call-1'] })
    ]
    const { roster } = testRoster(sessions)
    const posted: Posted[] = []

    const result = await toolNamed('list_agents', roster, posted).execute({}, context('a'))

    expect(result.content).toContain('held on a permission request')
    expect(result.content).toContain('id-b')
    expect(result.content).toContain('you')
  })
})

describe('starting another agent', () => {
  test('is the only tool that asks first', () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner')])
    const posted: Posted[] = []
    const asking = groveTools({ chat: { post: () => {}, list: () => [] } as never, roster })
      .filter((tool) => tool.policy === 'ask')
      .map((tool) => tool.name)

    expect(posted).toEqual([])
    // `request_review` parks the turn on purpose: that is how the review flow
    // holds the agent. Of the rest, only spawning asks.
    expect(asking).toEqual(['request_review', 'spawn_agent'])
  })

  test('labels the new session with the agent that asked for it', async () => {
    const sessions = [sessionMeta('a', 'Planner')]
    const { roster, created, delivered } = testRoster(sessions)
    const posted: Posted[] = []

    await toolNamed('spawn_agent', roster, posted).execute(
      { title: 'Reviewer', prompt: 'review the parser' },
      context('a')
    )

    expect(created[0].labels).toEqual({ [PARENT_LABEL]: 'a' })
    expect(delivered[0].text).toBe('review the parser')
    // The brief comes from grove, not from another agent, so it names no sender.
    expect(delivered[0].from).toBe('')
  })

  test('refuses a harness that is not mounted, rather than starting the default', async () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner')])
    const posted: Posted[] = []

    const result = await toolNamed('spawn_agent', roster, posted).execute(
      { title: 'Reviewer', prompt: 'review it', harness: 'nonesuch' },
      context('a')
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('claude')
  })
})

describe('a spawned agent finishing a turn', () => {
  /** A store stub that only does what the bridge asks of it. */
  function testStore(sessions: SessionMeta[]): {
    store: { subscribe: (listener: (event: SessionEvent) => void) => () => void; get: unknown }
    emit: (event: SessionEvent) => void
  } {
    let listener: ((event: SessionEvent) => void) | null = null
    return {
      store: {
        subscribe: (next: (event: SessionEvent) => void) => {
          listener = next
          return () => {
            listener = null
          }
        },
        get: (sessionId: string) =>
          Promise.resolve(sessions.find((session) => session.id === sessionId))
      },
      emit: (event) => listener?.(event)
    }
  }

  function envelope(sessionId: string): {
    id: string
    seq: number
    createdAt: string
    sessionId: string
  } {
    return { id: 'e', seq: 1, createdAt: '2026-01-01T00:00:00.000Z', sessionId }
  }

  /** The bridge answers over several awaits; let them all run. */
  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5))
  }

  test('reports its closing words to the agent that started it', async () => {
    const child = sessionMeta('child', 'Reviewer', { labels: { [PARENT_LABEL]: 'a' } })
    const sessions = [sessionMeta('a', 'Planner'), child]
    const { roster, delivered } = testRoster(sessions)
    const { store, emit } = testStore(sessions)
    new AgentHandoffBridge({ store: store as never, roster }).watch()

    emit({
      ...envelope('child'),
      type: 'agent.message_end',
      content: [{ type: 'text', text: 'the parser is fine' }],
      stopReason: 'end_turn'
    })
    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'end_turn' })
    await settle()

    expect(delivered).toEqual([
      // No agent-id label on this one, so the head of its session id stands in.
      { sessionId: 'a', from: 'Reviewer (child)', text: 'the parser is fine' }
    ])
  })

  test('says nothing twice: a turn that produced no new answer reports none', async () => {
    const child = sessionMeta('child', 'Reviewer', { labels: { [PARENT_LABEL]: 'a' } })
    const sessions = [sessionMeta('a', 'Planner'), child]
    const { roster, delivered } = testRoster(sessions)
    const { store, emit } = testStore(sessions)
    new AgentHandoffBridge({ store: store as never, roster }).watch()

    emit({
      ...envelope('child'),
      type: 'agent.message_end',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn'
    })
    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'end_turn' })
    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'end_turn' })
    await settle()

    expect(delivered).toHaveLength(1)
  })

  test('a session nobody spawned reports to nobody', async () => {
    const sessions = [sessionMeta('a', 'Planner'), sessionMeta('solo', 'Solo')]
    const { roster, delivered } = testRoster(sessions)
    const { store, emit } = testStore(sessions)
    new AgentHandoffBridge({ store: store as never, roster }).watch()

    emit({
      ...envelope('solo'),
      type: 'agent.message_end',
      content: [{ type: 'text', text: 'finished' }],
      stopReason: 'end_turn'
    })
    emit({ ...envelope('solo'), type: 'session.status_idle', stopReason: 'end_turn' })
    await settle()

    expect(delivered).toEqual([])
  })
})

describe('what grove tells an agent about the worktree', () => {
  function peer(agentId: string, title: string): AgentPeer {
    return {
      sessionId: agentId,
      agentId,
      title,
      harness: 'claude',
      model: 'opus',
      status: 'idle',
      waiting: false
    }
  }

  test('gives the agent its id, the others theirs, and the tools for reaching them', () => {
    const prompt = groveSystemPrompt({
      agentId: 'id-a',
      title: 'Planner',
      workspaceRoot: '/repo',
      peers: [peer('id-a', 'Planner'), peer('id-b', 'Builder')],
      harnesses: ['claude', 'pi']
    })

    expect(prompt).toContain('id-a')
    expect(prompt).toContain('id-b')
    expect(prompt).toContain('Builder')
    expect(prompt).toContain('send_message')
    expect(prompt).toContain('spawn_agent')
  })

  test('says so when nobody else is here, rather than listing an empty roster', () => {
    const prompt = groveSystemPrompt({
      agentId: 'id-a',
      title: 'Planner',
      workspaceRoot: '/repo',
      peers: [peer('id-a', 'Planner')],
      harnesses: ['claude']
    })

    expect(prompt).toContain('No other agent')
  })
})
