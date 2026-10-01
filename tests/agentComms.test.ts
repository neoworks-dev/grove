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
import { AgentHandoffBridge, DISPOSE_LABEL, PARENT_LABEL } from '../src/main/agents/handoffBridge'
import { AGENT_ID_LABEL } from '../src/main/agents/identity'
import { agentSection } from '../src/main/agents/systemPrompt'
import {
  applyEvent,
  createTranscript,
  senderOf,
  type AppItem,
  type ToolItem
} from '../src/renderer/src/lib/agents/transcript'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import type { AgentMode, SessionEvent, SessionMeta, ThinkingLevel } from '../src/shared/agents'
import type { Worktree } from '../src/shared/types'

interface Posted {
  root: string
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
    started: false,
    ...overrides
  }
}

interface CreatedSession {
  workspace: string
  title: string
  labels: Record<string, string> | undefined
  permissionMode: AgentMode | undefined
  harness: string | undefined
  thinkingLevel: ThinkingLevel | undefined
}

/** A roster over a fixed session list, recording what it was asked to deliver. */
function testRoster(
  sessions: SessionMeta[],
  logs: Record<string, SessionEvent[]> = {}
): {
  roster: AgentRoster
  delivered: Delivered[]
  created: CreatedSession[]
  removed: string[]
} {
  const delivered: Delivered[] = []
  const created: CreatedSession[] = []
  const removed: string[] = []
  const agents = {
    listSessions: () => Promise.resolve(sessions),
    listEvents: (sessionId: string) => Promise.resolve(logs[sessionId] ?? []),
    createSession: (options: {
      workspace: string
      title?: string
      labels?: Record<string, string>
      permissionMode?: AgentMode
      harness?: string
      thinkingLevel?: ThinkingLevel
    }) => {
      created.push({
        workspace: options.workspace,
        title: options.title ?? '',
        labels: options.labels,
        permissionMode: options.permissionMode,
        harness: options.harness,
        thinkingLevel: options.thinkingLevel
      })
      const spawned = sessionMeta('spawned', options.title ?? '', {
        labels: { [AGENT_ID_LABEL]: 'id-spawned', ...options.labels }
      })
      sessions.push(spawned)
      return Promise.resolve({ ...spawned, messageCount: 0 })
    },
    deleteSession: (sessionId: string) => {
      removed.push(sessionId)
      return Promise.resolve()
    },
    catalog: (harnessId: string) =>
      Promise.resolve({
        harness: harnessId,
        tools: [],
        commands: [],
        skills: [],
        models: [
          {
            key: `${harnessId}-opus`,
            label: `${harnessId}-opus`,
            routes: [
              {
                provider: 'anthropic',
                id: `${harnessId}-opus`,
                description: `${harnessId}-opus, as recommended`
              }
            ]
          }
        ],
        default: { provider: 'anthropic', model: `${harnessId}-opus` }
      }),
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
  const harnesses = {
    ids: () => ['claude', 'pi'],
    describe: () =>
      Promise.resolve([
        {
          id: 'claude',
          label: 'Claude',
          description: '',
          icon: '',
          capabilities: { groveTools: true },
          available: true,
          detail: null
        },
        {
          id: 'pi',
          label: 'pi',
          description: '',
          icon: '',
          capabilities: { groveTools: true },
          available: false,
          detail: 'not signed in'
        }
      ])
  }
  const roster = new AgentRoster({ agents: agents as never, harnesses: harnesses as never })
  return { roster, delivered, created, removed }
}

// The note and show tools are not what these tests are about. Of the
// worktrees, only the one a spawned agent may be sent to matters.
const WORKTREES: Worktree[] = [
  worktree('main', '/repo', { isMain: true }),
  worktree('12-parser', '/repo/.worktrees/12-parser')
]
const NO_SCREEN = {
  notes: {} as never,
  screen: { paneTypes: () => [] },
  worktrees: {
    list: () => Promise.resolve(WORKTREES),
    create: () => Promise.reject(new Error('not in these tests'))
  },
  conflicts: {} as never
}

function worktree(branch: string, path: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: branch,
    name: branch,
    path,
    branch,
    isMain: false,
    isDetached: false,
    locked: false,
    dirty: false,
    portSlot: 0,
    ...overrides
  }
}

function toolNamed(name: string, roster: AgentRoster, posted: Posted[]): GroveTool {
  const chat = {
    post: (root: string, from: { name: string }, text: string, to?: string) => {
      posted.push({ root, from: from.name, text, to })
      return Promise.resolve()
    },
    list: () => Promise.resolve([])
  }
  const tool = groveTools({ chat: chat as never, roster, ...NO_SCREEN }).find(
    (entry) => entry.name === name
  )
  if (!tool) throw new Error(`${name} is not offered`)
  return tool
}

function context(sessionId: string): GroveToolContext {
  return {
    sessionId,
    workspaceRoot: '/repo',
    surface: () => {},
    show: () => {}
  }
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
      { root: '/repo', from: 'Planner (id-a)', text: 'take the parser', to: 'Builder (id-b)' }
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

describe("reading another agent's transcript", () => {
  /**
   * A log of one event per line, and a tool line as the call and its result.
   * Agent lines are separate messages.
   */
  function log(sessionId: string, lines: [string, string][]): SessionEvent[] {
    const bodies: Record<string, unknown>[] = []
    for (const [type, text] of lines) {
      if (type === 'user') {
        bodies.push({ type: 'user.message', content: [{ type: 'text', text }] })
      } else if (type === 'tool') {
        bodies.push({
          type: 'update',
          update: { sessionUpdate: 'tool_call', toolCallId: 't', name: 'bash', title: 'bash', rawInput: {} }
        })
        bodies.push({
          type: 'update',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 't',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text } }]
          }
        })
      } else {
        bodies.push({
          type: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: `m${bodies.length}`,
            content: { type: 'text', text }
          }
        })
      }
    }
    return bodies.map((body, index) => ({
      ...body,
      id: `${sessionId}-${index}`,
      seq: index + 1,
      sessionId,
      createdAt: '2026-01-01T00:00:00.000Z'
    })) as SessionEvent[]
  }

  const logs = {
    a: log('a', [
      ['user', 'why is the parser slow?'],
      ['agent', 'the tokenizer re-reads the file on every pass'],
      ['tool', 'cargo bench output: 4.2s']
    ]),
    b: log('b', [['agent', 'left the tokenizer alone, it is not the bottleneck']])
  }

  test('reads what was said, and the tool traffic only when asked', async () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')], logs)
    const posted: Posted[] = []
    const read = toolNamed('read_transcript', roster, posted)

    const said = await read.execute({ agent: 'id-a' }, context('b'))
    expect(said.content).toContain('#1 user: why is the parser slow?')
    expect(said.content).toContain('#2 agent: the tokenizer')
    expect(said.content).not.toContain('cargo bench')

    const withTools = await read.execute({ agent: 'id-a', include_tools: true }, context('b'))
    expect(withTools.content).toContain('#4 tool (bash): cargo bench')
  })

  test('takes the last lines, and only those after a given event', async () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner')], logs)
    const read = toolNamed('read_transcript', roster, [])

    const tail = await read.execute({ agent: 'id-a', limit: 1 }, context('a'))
    expect(tail.content).toContain('#2 agent:')
    expect(tail.content).not.toContain('#1 user:')

    const since = await read.execute({ agent: 'id-a', since: 2 }, context('a'))
    expect(since.content).toContain('has said nothing yet')
  })

  test('searches every agent here and says which one said it', async () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner'), sessionMeta('b', 'Builder')], logs)
    const search = toolNamed('search_transcripts', roster, [])

    const hits = await search.execute({ query: 'tokenizer' }, context('a'))
    expect(hits.content).toContain('Planner (id-a)')
    expect(hits.content).toContain('Builder (id-b)')
    expect(hits.content).toContain('#2 agent: the tokenizer re-reads')

    const scoped = await search.execute({ query: 'tokenizer', agent: 'id-b' }, context('a'))
    expect(scoped.content).not.toContain('Planner')

    const nothing = await search.execute({ query: 'mutex' }, context('a'))
    expect(nothing.content).toContain('No agent has mentioned')
  })

  test('an unknown agent comes back as an error, not an empty transcript', async () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner')], logs)
    const result = await toolNamed('read_transcript', roster, []).execute(
      { agent: 'id-zzz' },
      context('a')
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('list_agents')
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

describe('reaching agents in other worktrees', () => {
  const CHILD_ROOT = '/repo/.worktrees/12-parser'

  function crossWorktreeSessions(): SessionMeta[] {
    return [
      sessionMeta('a', 'Planner'),
      sessionMeta('c', 'Parser', {
        workspaceRoot: CHILD_ROOT,
        labels: { [AGENT_ID_LABEL]: 'id-c', [PARENT_LABEL]: 'a' }
      }),
      sessionMeta('d', 'Lexer', { workspaceRoot: '/repo/.worktrees/13-lexer' })
    ]
  }

  test('a message by id reaches an agent in another worktree, and both channels show it', async () => {
    const { roster, delivered } = testRoster(crossWorktreeSessions())
    const posted: Posted[] = []

    const result = await toolNamed('send_message', roster, posted).execute(
      { to: 'id-c', text: 'rebase on main first' },
      context('a')
    )

    expect(result.isError).toBeUndefined()
    expect(delivered).toEqual([
      { sessionId: 'c', from: 'Planner (id-a)', text: 'rebase on main first' }
    ])
    expect(posted.map((entry) => entry.root)).toEqual(['/repo', CHILD_ROOT])
  })

  test('a title does not reach across worktrees', async () => {
    const { roster, delivered } = testRoster(crossWorktreeSessions())
    const posted: Posted[] = []

    const result = await toolNamed('send_message', roster, posted).execute(
      { to: 'Parser', text: 'hello' },
      context('a')
    )

    expect(result.isError).toBe(true)
    expect(delivered).toEqual([])
  })

  test('lists relatives in other worktrees, and everyone only when asked', async () => {
    const { roster } = testRoster(crossWorktreeSessions())
    const posted: Posted[] = []
    const list = toolNamed('list_agents', roster, posted)

    const relativesOnly = await list.execute({}, context('a'))
    expect(relativesOnly.content).toContain('In other worktrees:')
    expect(relativesOnly.content).toContain(`id-c · Parser`)
    expect(relativesOnly.content).toContain(`in ${CHILD_ROOT} · spawned by you`)
    expect(relativesOnly.content).not.toContain('id-d')

    const everyone = await list.execute({ all_worktrees: true }, context('a'))
    expect(everyone.content).toContain('id-d')
  })

  test('the child sees the parent that spawned it from another worktree', async () => {
    const { roster } = testRoster(crossWorktreeSessions())

    const relatives = await roster.relativesElsewhere('c')

    expect(relatives.map((peer) => peer.agentId)).toEqual(['id-a'])
  })
})

describe('starting another agent', () => {
  test('is the only tool that asks first', () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner')])
    const posted: Posted[] = []
    const asking = groveTools({
      chat: { post: () => {}, list: () => [] } as never,
      roster,
      ...NO_SCREEN
    })
      .filter((tool) => tool.policy === 'ask')
      .map((tool) => tool.name)

    expect(posted).toEqual([])
    // Only spawning an agent or a worktree asks.
    expect(asking).toEqual(['spawn_agent', 'create_worktree'])
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
    // The brief is the spawning agent talking, so the child opens on a message
    // from it rather than on an unattributed task.
    expect(delivered[0].from).toBe('Planner (id-a)')
  })

  test("starts the agent in its parent's permission mode", async () => {
    const sessions = [sessionMeta('a', 'Planner', { permissionMode: 'bypass' })]
    const { roster, created } = testRoster(sessions)
    const posted: Posted[] = []

    await toolNamed('spawn_agent', roster, posted).execute(
      { title: 'Worker', prompt: 'fix #12' },
      context('a')
    )

    // A child left in the default mode would stop on every approval the parent
    // was running without.
    expect(created[0].permissionMode).toBe('bypass')
  })

  test('starts the agent in the worktree it was given', async () => {
    const sessions = [sessionMeta('a', 'Planner')]
    const { roster, created } = testRoster(sessions)
    const posted: Posted[] = []

    const result = await toolNamed('spawn_agent', roster, posted).execute(
      { title: 'Parser', prompt: 'fix #12', worktree: '12-parser' },
      context('a')
    )

    expect(result.isError).toBeUndefined()
    expect(created[0].workspace).toBe('/repo/.worktrees/12-parser')
    // It is still the caller's child, so its answers come back across worktrees.
    expect(created[0].labels).toEqual({ [PARENT_LABEL]: 'a' })
  })

  test("stays in the caller's worktree when none is named", async () => {
    const sessions = [sessionMeta('a', 'Planner')]
    const { roster, created } = testRoster(sessions)
    const posted: Posted[] = []

    await toolNamed('spawn_agent', roster, posted).execute(
      { title: 'Reviewer', prompt: 'review it' },
      context('a')
    )

    expect(created[0].workspace).toBe('/repo')
  })

  test('refuses a worktree that does not exist, before a session exists', async () => {
    const sessions = [sessionMeta('a', 'Planner')]
    const { roster, created } = testRoster(sessions)
    const posted: Posted[] = []

    const result = await toolNamed('spawn_agent', roster, posted).execute(
      { title: 'Parser', prompt: 'fix #13', worktree: '13-lexer' },
      context('a')
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('12-parser')
    expect(result.content).toContain('create_worktree')
    expect(created).toEqual([])
  })

  test('reports which runtimes can run, and on what', async () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner')])
    const posted: Posted[] = []

    const result = await toolNamed('list_runtimes', roster, posted).execute({}, context('a'))

    expect(result.content).toContain('claude · ready')
    expect(result.content).toContain('claude-opus')
    // A runtime nobody has signed into says so rather than looking spawnable.
    expect(result.content).toContain('unavailable (not signed in)')
  })

  test('refuses a model the chosen runtime cannot run, before a session exists', async () => {
    const sessions = [sessionMeta('a', 'Planner')]
    const { roster, created } = testRoster(sessions)
    const posted: Posted[] = []

    const result = await toolNamed('spawn_agent', roster, posted).execute(
      { title: 'Reviewer', prompt: 'review it', harness: 'pi', model: 'claude-opus' },
      context('a')
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('pi-opus')
    expect(created).toEqual([])
  })

  test('takes a model the runtime does offer', async () => {
    const sessions = [sessionMeta('a', 'Planner')]
    const { roster, created } = testRoster(sessions)
    const posted: Posted[] = []

    const result = await toolNamed('spawn_agent', roster, posted).execute(
      { title: 'Reviewer', prompt: 'review it', harness: 'pi', model: 'pi-opus' },
      context('a')
    )

    expect(result.isError).toBeUndefined()
    expect(created).toHaveLength(1)
  })

  test('marks a one-shot helper for removal when asked to', async () => {
    const sessions = [sessionMeta('a', 'Planner')]
    const { roster, created } = testRoster(sessions)
    const posted: Posted[] = []

    const result = await toolNamed('spawn_agent', roster, posted).execute(
      { title: 'Reader', prompt: 'read it', removeWhenDone: true },
      context('a')
    )

    expect(created[0].labels).toEqual({ [PARENT_LABEL]: 'a', [DISPOSE_LABEL]: 'whenDone' })
    // The caller is told not to plan on talking to it.
    expect(result.content).toContain('removed')
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

describe('a spawned agent finishing a turn, or being closed', () => {
  /** A store stub that only does what the bridge asks of it, keeping what it was given. */
  function testStore(sessions: SessionMeta[]): {
    store: {
      subscribe: (listener: (event: SessionEvent) => void) => () => void
      get: unknown
      list: unknown
      peekEvents: unknown
    }
    emit: (event: SessionEvent) => void
  } {
    let listener: ((event: SessionEvent) => void) | null = null
    const logs = new Map<string, SessionEvent[]>()
    let seq = 0
    return {
      store: {
        peekEvents: (sessionId: string) => logs.get(sessionId) ?? [],
        subscribe: (next: (event: SessionEvent) => void) => {
          listener = next
          return () => {
            listener = null
          }
        },
        get: (sessionId: string) =>
          Promise.resolve(sessions.find((session) => session.id === sessionId)),
        list: () => Promise.resolve(sessions)
      },
      emit: (event) => {
        seq += 1
        const stamped = { ...event, seq, id: `e${seq}` } as SessionEvent
        logs.set(event.sessionId, [...(logs.get(event.sessionId) ?? []), stamped])
        listener?.(stamped)
      }
    }
  }

  /** A whole message from the agent, as one ACP chunk. */
  function says(sessionId: string, text: string): SessionEvent {
    return chunk(sessionId, text)
  }

  function chunk(sessionId: string, text: string): SessionEvent {
    return {
      ...envelope(sessionId),
      type: 'update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
    } as SessionEvent
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

    emit(says('child', 'the parser is fine'))
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

    emit(says('child', 'done'))
    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'end_turn' })
    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'end_turn' })
    await settle()

    expect(delivered).toHaveLength(1)
  })

  test('reports the whole of an answer streamed in chunks', async () => {
    const child = sessionMeta('child', 'PiEcho', { labels: { [PARENT_LABEL]: 'a' } })
    const sessions = [sessionMeta('a', 'Planner'), child]
    const { roster, delivered } = testRoster(sessions)
    const { store, emit } = testStore(sessions)
    new AgentHandoffBridge({ store: store as never, roster }).watch()

    emit(chunk('child', 'pi-'))
    emit(chunk('child', 'pong'))
    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'end_turn' })
    await settle()

    expect(delivered).toEqual([{ sessionId: 'a', from: 'PiEcho (child)', text: 'pi-pong' }])
  })

  test('a one-shot helper is removed once its answer has been delivered', async () => {
    const child = sessionMeta('child', 'Reader', {
      labels: { [PARENT_LABEL]: 'a', [DISPOSE_LABEL]: 'whenDone' }
    })
    const sessions = [sessionMeta('a', 'Planner'), child]
    const { roster, delivered, removed } = testRoster(sessions)
    const { store, emit } = testStore(sessions)
    new AgentHandoffBridge({ store: store as never, roster }).watch()

    emit(says('child', 'the file says hello'))
    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'end_turn' })
    await settle()

    expect(delivered).toHaveLength(1)
    expect(removed).toEqual(['child'])
  })

  test('an agent that answered nothing is left alone rather than removed unheard', async () => {
    const child = sessionMeta('child', 'Reader', {
      labels: { [PARENT_LABEL]: 'a', [DISPOSE_LABEL]: 'whenDone' }
    })
    const sessions = [sessionMeta('a', 'Planner'), child]
    const { roster, delivered, removed } = testRoster(sessions)
    const { store, emit } = testStore(sessions)
    new AgentHandoffBridge({ store: store as never, roster }).watch()

    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'aborted' })
    await settle()

    expect(delivered).toEqual([])
    expect(removed).toEqual([])
  })

  test('an agent nobody asked to remove stays', async () => {
    const child = sessionMeta('child', 'Reviewer', { labels: { [PARENT_LABEL]: 'a' } })
    const sessions = [sessionMeta('a', 'Planner'), child]
    const { roster, removed } = testRoster(sessions)
    const { store, emit } = testStore(sessions)
    new AgentHandoffBridge({ store: store as never, roster }).watch()

    emit(says('child', 'done'))
    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'end_turn' })
    await settle()

    expect(removed).toEqual([])
  })

  test('a session nobody spawned reports to nobody', async () => {
    const sessions = [sessionMeta('a', 'Planner'), sessionMeta('solo', 'Solo')]
    const { roster, delivered } = testRoster(sessions)
    const { store, emit } = testStore(sessions)
    new AgentHandoffBridge({ store: store as never, roster }).watch()

    emit(says('solo', 'finished'))
    emit({ ...envelope('solo'), type: 'session.status_idle', stopReason: 'end_turn' })
    await settle()

    expect(delivered).toEqual([])
  })

  test('a closed agent tells the one that started it that it is gone', async () => {
    const child = sessionMeta('child', 'Reviewer', { labels: { [PARENT_LABEL]: 'a' } })
    const sessions = [sessionMeta('a', 'Planner'), child]
    const { roster, delivered } = testRoster(sessions)
    const { store } = testStore(sessions)
    const bridge = new AgentHandoffBridge({ store: store as never, roster })

    await bridge.reportClosed(child as never)

    expect(delivered).toHaveLength(1)
    expect(delivered[0].sessionId).toBe('a')
    expect(delivered[0].from).toBe('Reviewer (child)')
    expect(delivered[0].text).toContain('no longer reachable')
  })

  test('a closed agent tells the agents it spawned that their requester is gone', async () => {
    const parent = sessionMeta('a', 'Planner')
    const child = sessionMeta('child', 'Reviewer', { labels: { [PARENT_LABEL]: 'a' } })
    const sessions = [parent, child]
    const { roster, delivered } = testRoster(sessions)
    const { store } = testStore(sessions)
    const bridge = new AgentHandoffBridge({ store: store as never, roster })

    await bridge.reportClosed(parent as never)

    expect(delivered).toHaveLength(1)
    expect(delivered[0].sessionId).toBe('child')
    expect(delivered[0].from).toBe('Planner (id-a)')
    expect(delivered[0].text).toContain('closed')
  })

  test('an agent removed after reporting back says goodbye only once', async () => {
    const child = sessionMeta('child', 'Reader', {
      labels: { [PARENT_LABEL]: 'a', [DISPOSE_LABEL]: 'whenDone' }
    })
    const sessions = [sessionMeta('a', 'Planner'), child]
    const { roster, delivered } = testRoster(sessions)
    const { store, emit } = testStore(sessions)
    const bridge = new AgentHandoffBridge({ store: store as never, roster })
    bridge.watch()

    emit(says('child', 'the file says hello'))
    emit({ ...envelope('child'), type: 'session.status_idle', stopReason: 'end_turn' })
    await settle()
    await bridge.reportClosed(child as never)

    expect(delivered).toEqual([
      { sessionId: 'a', from: 'Reader (child)', text: 'the file says hello' }
    ])
  })

  test('closing a session nobody is working with tells nobody', async () => {
    const solo = sessionMeta('solo', 'Solo')
    const sessions = [sessionMeta('a', 'Planner'), solo]
    const { roster, delivered } = testRoster(sessions)
    const { store } = testStore(sessions)
    const bridge = new AgentHandoffBridge({ store: store as never, roster })

    await bridge.reportClosed(solo as never)

    expect(delivered).toEqual([])
  })
})

describe('what grove tells an agent about the worktree', () => {
  function peer(agentId: string, title: string): AgentPeer {
    return {
      sessionId: agentId,
      agentId,
      title,
      workspaceRoot: '/repo',
      parentSessionId: null,
      harness: 'claude',
      model: 'opus',
      status: 'idle',
      waiting: false
    }
  }

  test('gives the agent its id and lists the others by theirs', () => {
    const prompt = agentSection({
      agentId: 'id-a',
      title: 'Planner',
      peers: [peer('id-a', 'Planner'), peer('id-b', 'Builder')],
      relatives: []
    })

    expect(prompt).toStartWith('<agent>')
    expect(prompt).toContain('You are "Planner", id id-a.')
    expect(prompt).toContain('- id-b: "Builder"')
  })

  test('lists no roster when nobody else is here', () => {
    const prompt = agentSection({
      agentId: 'id-a',
      title: 'Planner',
      peers: [peer('id-a', 'Planner')],
      relatives: []
    })

    expect(prompt).not.toContain('Other agents in this worktree')
    expect(prompt).not.toContain('from other worktrees')
  })

  test('names the parent working in another worktree, so a child knows who to ask', () => {
    const prompt = agentSection({
      agentId: 'id-c',
      title: 'Parser',
      peers: [peer('id-c', 'Parser')],
      relatives: [peer('id-a', 'Planner')]
    })

    expect(prompt).toContain('Agents working with you from other worktrees')
    expect(prompt).toContain('- id-a: "Planner" in /repo')
  })
})

describe('who an app message came from', () => {
  function appItem(label: string, from?: string): AppItem {
    return { kind: 'app', seq: 1, eventId: 'e', label, text: 'pong', from }
  }

  test('is the sender the event names', () => {
    expect(senderOf(appItem('Agent message', 'Echo (155a4e)'))).toBe('Echo (155a4e)')
  })

  test('is read off the label for messages recorded before events carried one', () => {
    expect(senderOf(appItem('Message from Echo (155a4e)'))).toBe('Echo (155a4e)')
  })

  test('is nobody when grove sent it itself', () => {
    expect(senderOf(appItem('Review feedback'))).toBeNull()
  })
})

describe('a spawn that names a model', () => {
  test('carries the provider that serves it, which pi needs to honour the choice', async () => {
    const sessions = [sessionMeta('a', 'Planner')]
    const { roster } = testRoster(sessions)
    const created: { model?: string; provider?: string }[] = []
    const spy = roster as unknown as {
      options: { agents: { createSession: (options: Record<string, unknown>) => unknown } }
    }
    const original = spy.options.agents.createSession
    spy.options.agents.createSession = (options): unknown => {
      created.push({ model: options.model as string, provider: options.provider as string })
      return original(options)
    }

    await roster.spawn({
      workspaceRoot: '/repo',
      title: 'Reader',
      harness: 'pi',
      model: 'pi-opus',
      prompt: 'read it',
      parentSessionId: 'a'
    })

    expect(created).toEqual([{ model: 'pi-opus', provider: 'anthropic' }])
  })

  test('keeps the provider its approval picked over the first one serving the model', async () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner')])
    const created: { model?: string; provider?: string }[] = []
    const spy = roster as unknown as {
      options: { agents: { createSession: (options: Record<string, unknown>) => unknown } }
    }
    const original = spy.options.agents.createSession
    spy.options.agents.createSession = (options): unknown => {
      created.push({ model: options.model as string, provider: options.provider as string })
      return original(options)
    }

    await roster.spawn({
      workspaceRoot: '/repo',
      title: 'Reader',
      harness: 'pi',
      model: 'pi-opus',
      provider: 'bedrock',
      prompt: 'read it',
      parentSessionId: 'a'
    })

    expect(created).toEqual([{ model: 'pi-opus', provider: 'bedrock' }])
  })
})

describe('what a spawn runs on', () => {
  test("its approval names the parent's runtime and the model its default resolves to", async () => {
    const sessions = [sessionMeta('a', 'Planner', { harness: 'pi' })]
    const { roster } = testRoster(sessions)

    const described = await toolNamed('spawn_agent', roster, []).describe?.(
      { title: 'Reviewer', prompt: 'review it' },
      context('a')
    )

    expect(described?._meta).toEqual({
      grove: {
        spawn: {
          harness: 'pi',
          provider: 'anthropic',
          model: 'pi-opus',
          modelIsDefault: true,
          modelDescription: 'pi-opus, as recommended',
          effort: null
        }
      }
    })
  })

  test('its approval names the model and effort the call asked for', async () => {
    const { roster } = testRoster([sessionMeta('a', 'Planner')])

    const described = await toolNamed('spawn_agent', roster, []).describe?.(
      { title: 'Reviewer', prompt: 'review it', harness: 'pi', model: 'pi-opus', effort: 'medium' },
      context('a')
    )

    expect(described?._meta).toEqual({
      grove: {
        spawn: {
          harness: 'pi',
          provider: 'anthropic',
          model: 'pi-opus',
          modelIsDefault: false,
          modelDescription: 'pi-opus, as recommended',
          effort: 'medium'
        }
      }
    })
  })

  test('starts on the effort it was given', async () => {
    const { roster, created } = testRoster([sessionMeta('a', 'Planner')])

    const result = await toolNamed('spawn_agent', roster, []).execute(
      { title: 'Worker', prompt: 'fix #12', effort: 'high' },
      context('a')
    )

    expect(result.isError).toBeUndefined()
    expect(created[0].thinkingLevel).toBe('high')
  })

  test('starts on the runtime its approval named when the call names none', async () => {
    const { roster, created } = testRoster([sessionMeta('a', 'Planner', { harness: 'pi' })])

    await toolNamed('spawn_agent', roster, []).execute(
      { title: 'Worker', prompt: 'fix #12' },
      context('a')
    )

    // Left to the session service, it would open on grove's default runtime
    // while the approval, and the model check, went by the parent's.
    expect(created[0].harness).toBe('pi')
  })

  test('refuses an effort it does not know', async () => {
    const { roster, created } = testRoster([sessionMeta('a', 'Planner')])

    const result = await toolNamed('spawn_agent', roster, []).execute(
      { title: 'Worker', prompt: 'fix #12', effort: 'ludicrous' },
      context('a')
    )

    expect(result.isError).toBe(true)
    expect(created).toEqual([])
  })

  test('the transcript keeps what the approval was told', () => {
    const target = {
      harness: 'pi',
      provider: 'anthropic',
      model: 'pi-opus',
      modelIsDefault: true,
      modelDescription: null,
      effort: null
    }
    const toolCall = {
      toolCallId: 'call-1',
      name: 'mcp__grove__spawn_agent',
      title: 'Start another agent',
      rawInput: { title: 'Reviewer', prompt: 'review it' },
      _meta: { grove: { spawn: target } }
    }
    const events = [
      {
        id: 'e1',
        seq: 1,
        at: '2026-01-01T00:00:00.000Z',
        type: 'permission',
        request: { sessionId: 'h', toolCall, options: [] }
      }
    ] as unknown as SessionEvent[]

    const state = createTranscript()
    for (const event of events) applyEvent(state, event)
    const tool = state.items.find((item) => item.kind === 'tool') as ToolItem

    expect(tool.spawn).toEqual(target)
  })
})
