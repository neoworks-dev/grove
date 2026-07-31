// agents.* routes: observe and drive agent sessions on the embedded nib server.
//
// Chat references over the wire are nib session ids scoped to a worktree, so a
// client never enumerates internals and never reaches a session outside the
// worktree it asked about. agents.run is a danger scope: sends spend money and
// agents can edit files. Answering approvals is deliberately not exposed — a
// client resolving the agent's own permission prompts would be privilege
// escalation.

import type { WorktreeChatMessage } from '../../../shared/types'
import { ApiError, type RouteRegistry } from '../registry'

// The subset of nib's protocol these routes speak. Kept structural so this
// module does not depend on the renderer's vendored copy of nib's types.
interface NibSession {
  id: string
  title: string
  workspaceRoot: string
  provider: string
  model: string
  status: string
  live: boolean
}

interface NibEvent {
  seq: number
  type: string
  [key: string]: unknown
}

export interface AgentsRouteDeps {
  // Sessions across every workspace; routes filter to the requested worktree.
  listSessions: () => Promise<NibSession[]>
  listModels: () => Promise<{ provider: string; models: { id: string }[] }[]>
  listEvents: (sessionId: string, after: number) => Promise<NibEvent[]>
  createSession: (workspace: string, title?: string) => Promise<NibSession>
  send: (sessionId: string, text: string) => Promise<void>
  interrupt: (sessionId: string) => Promise<void>
  unqueue: (sessionId: string, messageId: string) => Promise<void>
  // Subscribe to one session's stream; the returned function unsubscribes.
  observe: (sessionId: string, onEvent: (event: NibEvent) => void) => () => void
  sendChatAs: (
    worktreeId: string,
    from: { kind: 'agent'; name: string },
    text: string
  ) => Promise<WorktreeChatMessage>
  chatHistory: (worktreeId: string, since?: number) => Promise<WorktreeChatMessage[]>
}

export function registerAgentsRoutes(registry: RouteRegistry, deps: AgentsRouteDeps): void {
  /** Resolve a session id, refusing one that belongs to another worktree. */
  async function sessionIn(worktreePath: string, raw: unknown): Promise<NibSession> {
    const sessionId = String(raw ?? '')
    if (!sessionId) throw new ApiError('chatId is required', 'invalid')
    const sessions = await deps.listSessions()
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (!session || session.workspaceRoot !== worktreePath) {
      throw new ApiError(`unknown chat: ${sessionId}`, 'invalid')
    }
    return session
  }

  // ── Read ──────────────────────────────────────────────────────
  registry.register({
    method: 'agents.listChats',
    scope: 'agents.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const sessions = await deps.listSessions()
      return sessions
        .filter((session) => session.workspaceRoot === worktree.path)
        .map((session) => ({
          id: session.id,
          worktreeId: worktree.id,
          title: session.title,
          running: session.status === 'running'
        }))
    }
  })

  registry.register({
    method: 'agents.listModels',
    scope: 'agents.read',
    handler: async () => {
      const providers = await deps.listModels().catch(() => [])
      const models: { id: string; label: string }[] = []
      for (const entry of providers) {
        for (const model of entry.models) {
          models.push({
            id: `${entry.provider}:${model.id}`,
            label: `${entry.provider}: ${model.id}`
          })
        }
      }
      return models
    }
  })

  registry.register({
    method: 'agents.readTranscript',
    scope: 'agents.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const session = await sessionIn(worktree.path, args.chatId)
      const events = await deps.listEvents(session.id, 0)
      return events.map((event) => ({ type: 'event', payload: event }))
    }
  })

  registry.register({
    method: 'agents.isRunning',
    scope: 'agents.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const session = await sessionIn(worktree.path, args.chatId)
      return session.status === 'running'
    }
  })

  // Live observation: one session's events, ending when its turn does.
  registry.register({
    method: 'agents.observe',
    scope: 'agents.read',
    streaming: true,
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const session = await sessionIn(worktree.path, args.chatId)

      return new Promise<null>((resolve) => {
        let unsubscribe = (): void => {}
        const finish = (): void => {
          unsubscribe()
          resolve(null)
        }
        unsubscribe = deps.observe(session.id, (event) => {
          context.emit([{ type: 'event', payload: event }])
          if (event.type === 'session.status_idle') finish()
          if (event.type === 'session.status_terminated') finish()
        })
        context.signal.addEventListener('abort', finish)
        if (session.status !== 'running') finish()
      })
    }
  })

  registry.register({
    method: 'agents.channelHistory',
    scope: 'agents.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const since = args.since === undefined ? undefined : Number(args.since)
      const messages = await deps.chatHistory(worktree.id, since)
      return messages.map((message) => ({ type: 'chat-message', payload: message }))
    }
  })

  // ── Drive (danger scope) ──────────────────────────────────────
  registry.register({
    method: 'agents.createChat',
    scope: 'agents.run',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const title = args.title === undefined ? undefined : String(args.title)
      const session = await deps.createSession(worktree.path, title)
      return { chatId: session.id }
    }
  })

  registry.register({
    method: 'agents.send',
    scope: 'agents.run',
    describe: (args) => `send to agent chat ${String(args.chatId ?? '')}`,
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const session = await sessionIn(worktree.path, args.chatId)
      await deps.send(session.id, String(args.message ?? ''))
    }
  })

  registry.register({
    method: 'agents.stop',
    scope: 'agents.run',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const session = await sessionIn(worktree.path, args.chatId)
      await deps.interrupt(session.id)
    }
  })

  registry.register({
    method: 'agents.cancelQueued',
    scope: 'agents.run',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const session = await sessionIn(worktree.path, args.chatId)
      await deps.unqueue(session.id, String(args.queueId ?? ''))
    }
  })

  registry.register({
    method: 'agents.sendChannelMessage',
    scope: 'agents.run',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const text = String(args.text ?? '').trim()
      if (text.length === 0) throw new ApiError('text is required', 'invalid')
      // Host-stamped identity: the channel shows exactly which client spoke.
      await deps.sendChatAs(worktree.id, { kind: 'agent', name: context.client.key }, text)
    }
  })
}
