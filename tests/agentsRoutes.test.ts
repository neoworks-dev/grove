import { describe, it, expect } from 'bun:test'
import { RouteRegistry, type RouteContext } from '../src/main/api/registry'
import { registerAgentsRoutes, type AgentsRouteDeps } from '../src/main/api/routes/agents'
import type { Worktree, WorktreeChatMessage } from '../src/shared/types'

// Two worktrees, each with one session, so "reach a session in the other
// worktree by id" is expressible — which is the thing these routes must refuse.
const mine = { id: '/tmp/mine', path: '/tmp/mine', branch: 'main' } as Worktree
const theirs = { id: '/tmp/theirs', path: '/tmp/theirs', branch: 'other' } as Worktree

function session(
  id: string,
  workspaceRoot: string,
  status = 'idle'
): {
  id: string
  title: string
  workspaceRoot: string
  provider: string
  model: string
  status: string
  live: boolean
} {
  return {
    id,
    title: `Session ${id}`,
    workspaceRoot,
    provider: 'anthropic',
    model: 'claude',
    status,
    live: true
  }
}

interface Harness {
  call: (method: string, args?: Record<string, unknown>, worktree?: Worktree) => Promise<unknown>
  sent: { sessionId: string; text: string }[]
  posted: { worktreeId: string; from: string; text: string }[]
}

function build(overrides: Partial<AgentsRouteDeps> = {}): Harness {
  const sent: { sessionId: string; text: string }[] = []
  const posted: { worktreeId: string; from: string; text: string }[] = []

  const deps: AgentsRouteDeps = {
    listSessions: async () => [session('a', mine.path, 'running'), session('b', theirs.path)],
    listModels: async () => [{ provider: 'anthropic', models: [{ id: 'claude' }] }],
    listEvents: async (sessionId) => [{ seq: 1, type: 'agent.text', sessionId }],
    createSession: async (workspace) => session('new', workspace),
    send: async (sessionId, text) => {
      sent.push({ sessionId, text })
    },
    interrupt: async () => {},
    unqueue: async () => {},
    observe: () => () => {},
    sendChatAs: async (worktreeId, from, text) => {
      posted.push({ worktreeId, from: from.name, text })
      return { id: '1', worktreeId, from, text, ts: 0 } as WorktreeChatMessage
    },
    chatHistory: async () => [],
    ...overrides
  }

  const registry = new RouteRegistry()
  registerAgentsRoutes(registry, deps)

  const call = async (
    method: string,
    args: Record<string, unknown> = {},
    worktree: Worktree = mine
  ): Promise<unknown> => {
    const route = registry.get(method)
    if (!route) throw new Error(`route not registered: ${method}`)
    const context = {
      client: { key: 'plugin:test.plugin' },
      worktreeFor: () => worktree,
      emit: () => {},
      signal: new AbortController().signal
    } as unknown as RouteContext
    return route.handler(args, context)
  }

  return { call, sent, posted }
}

describe('agents routes over nib', () => {
  it('lists only the sessions rooted at the worktree asked about', async () => {
    const { call } = build()

    expect(await call('agents.listChats')).toEqual([
      { id: 'a', worktreeId: mine.id, title: 'Session a', running: true }
    ])
  })

  it('refuses a session belonging to another worktree', async () => {
    const { call } = build()

    // 'b' exists, so this is authorization rather than a lookup miss.
    await expect(call('agents.readTranscript', { chatId: 'b' })).rejects.toThrow('unknown chat: b')
    await expect(call('agents.send', { chatId: 'b', message: 'hi' })).rejects.toThrow('unknown chat: b')
    await expect(call('agents.stop', { chatId: 'b' })).rejects.toThrow('unknown chat: b')
  })

  it('requires a chat id rather than defaulting to whatever session is around', async () => {
    const { call } = build()

    await expect(call('agents.isRunning', {})).rejects.toThrow('chatId is required')
  })

  it('sends to a session in the caller’s own worktree', async () => {
    const { call, sent } = build()

    await call('agents.send', { chatId: 'a', message: 'go' })

    expect(sent).toEqual([{ sessionId: 'a', text: 'go' }])
  })

  it('creates sessions rooted at the worktree path and answers with the session id', async () => {
    const created: string[] = []
    const { call } = build({
      createSession: async (workspace) => {
        created.push(workspace)
        return session('new', workspace)
      }
    })

    expect(await call('agents.createChat', { title: 'Work' })).toEqual({ chatId: 'new' })
    expect(created).toEqual([mine.path])
  })

  it('flattens the model listing to provider-qualified ids', async () => {
    const { call } = build()

    expect(await call('agents.listModels')).toEqual([
      { id: 'anthropic:claude', label: 'anthropic: claude' }
    ])
  })

  it('reports no models rather than failing when nib is unreachable', async () => {
    const { call } = build({
      listModels: async () => {
        throw new Error('socket closed')
      }
    })

    expect(await call('agents.listModels')).toEqual([])
  })

  it('stamps a channel message with the calling client, not with what it claims to be', async () => {
    const { call, posted } = build()

    await call('agents.sendChannelMessage', { text: 'ready', from: 'someone-else' })

    expect(posted).toEqual([{ worktreeId: mine.id, from: 'plugin:test.plugin', text: 'ready' }])
  })

  it('rejects an empty channel message', async () => {
    const { call } = build()

    await expect(call('agents.sendChannelMessage', { text: '   ' })).rejects.toThrow('text is required')
  })

  it('keeps answering approvals off the wire entirely', () => {
    const registry = new RouteRegistry()
    registerAgentsRoutes(registry, {} as AgentsRouteDeps)
    const methods = registry.methods()

    // A client resolving the agent's own permission prompts would be privilege
    // escalation: the review flow is the only thing allowed to answer them.
    expect(methods.some((method) => method.includes('ermission'))).toBe(false)
    expect(methods.some((method) => method.includes('onfirm'))).toBe(false)
  })
})
