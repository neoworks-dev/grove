// agents.* routes: observe and drive agent runs. Chat references over the
// wire are '<agentName>/<chatId>' plus a worktreeId — the adapter name is
// part of the id so clients never enumerate internals. Everything a client
// posts into the shared channel is stamped with its host-known identity.
// agents.run is a danger scope: sends spend money and agents can edit files.
// respondPermission/respondDialog are deliberately not exposed — a client
// answering the agent's permission prompts would be privilege escalation.

import type { AgentChats, AgentRuntime, WorktreeChatMessage, Worktree } from '../../../shared/types'
import type { EventHub, ApiEvent } from '../events'
import { ApiError, type RouteRegistry } from '../registry'

export interface AgentsRouteDeps {
  hub: EventHub
  agentNames: () => string[]
  listChats: (worktreeId: string, name: string) => AgentChats
  listInstances: (worktreeId: string) => AgentRuntime[]
  listModels: (name: string) => Promise<{ label: string; value: string }[]>
  isRunning: (worktreeId: string, name: string, chatId: string) => boolean
  createInstance: (worktreeId: string, name: string, label?: string) => { id: string }
  send: (worktreeId: string, name: string, text: string, chatId: string) => Promise<unknown>
  stop: (worktreeId: string, name: string, chatId: string) => Promise<void>
  cancelQueued: (worktreeId: string, name: string, chatId: string, queueId: string) => void
  readTranscript: (worktree: Worktree, name: string, chatId: string) => Promise<string[]>
  sendChatAs: (
    worktreeId: string,
    from: { kind: 'agent'; name: string },
    text: string
  ) => WorktreeChatMessage
  chatHistory: (worktreeId: string, since?: number) => WorktreeChatMessage[]
}

interface ChatRef {
  name: string
  chatId: string
}

function parseChatRef(raw: unknown): ChatRef {
  const ref = String(raw ?? '')
  const separator = ref.indexOf('/')
  if (separator <= 0 || separator === ref.length - 1) {
    throw new ApiError('chatId must be "<agentName>/<chatId>"', 'invalid')
  }
  return { name: ref.slice(0, separator), chatId: ref.slice(separator + 1) }
}

export function registerAgentsRoutes(registry: RouteRegistry, deps: AgentsRouteDeps): void {
  // ── Read ──────────────────────────────────────────────────────
  registry.register({
    method: 'agents.listChats',
    scope: 'agents.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const chats: unknown[] = []
      for (const name of deps.agentNames()) {
        for (const chat of deps.listChats(worktree.id, name).chats) {
          chats.push({
            id: `${name}/${chat.id}`,
            worktreeId: worktree.id,
            title: chat.name,
            running: deps.isRunning(worktree.id, name, chat.id)
          })
        }
      }
      return chats
    }
  })

  registry.register({
    method: 'agents.listModels',
    scope: 'agents.read',
    handler: async () => {
      const models: { id: string; label: string }[] = []
      for (const name of deps.agentNames()) {
        const options = await deps.listModels(name).catch(() => [])
        for (const option of options) {
          models.push({ id: `${name}:${option.value}`, label: `${name}: ${option.label}` })
        }
      }
      return models
    }
  })

  registry.register({
    method: 'agents.readTranscript',
    scope: 'agents.read',
    handler: async (args, context) => {
      const ref = parseChatRef(args.chatId)
      const worktree = context.worktreeFor(args)
      const lines = await deps.readTranscript(worktree, ref.name, ref.chatId)
      return lines.map((line) => ({ type: 'line', payload: line }))
    }
  })

  registry.register({
    method: 'agents.isRunning',
    scope: 'agents.read',
    handler: async (args, context) => {
      const ref = parseChatRef(args.chatId)
      const worktree = context.worktreeFor(args)
      return deps.isRunning(worktree.id, ref.name, ref.chatId)
    }
  })

  // Live observation: agent log lines + status transitions for one chat,
  // ending when the run stops.
  registry.register({
    method: 'agents.observe',
    scope: 'agents.read',
    streaming: true,
    handler: (args, context) => {
      const ref = parseChatRef(args.chatId)
      const worktree = context.worktreeFor(args)
      return new Promise<null>((resolve) => {
        const finish = (unsubscribe: () => void): void => {
          unsubscribe()
          resolve(null)
        }
        const unsubscribe = deps.hub.subscribe(['agents.log', 'agents.didChangeStatus'], (event) => {
          if (!matchesChat(event, worktree.id, ref)) return
          if (event.topic === 'agents.log') {
            context.emit([{ type: 'log', payload: (event.payload as { line: string }).line }])
            return
          }
          const runtime = event.payload as AgentRuntime
          context.emit([{ type: 'status', payload: runtime.status }])
          if (runtime.status !== 'running') finish(unsubscribe)
        })
        context.signal.addEventListener('abort', () => finish(unsubscribe))
        if (!deps.isRunning(worktree.id, ref.name, ref.chatId)) finish(unsubscribe)
      })
    }
  })

  registry.register({
    method: 'agents.channelHistory',
    scope: 'agents.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const since = args.since === undefined ? undefined : Number(args.since)
      return deps.chatHistory(worktree.id, since).map((message) => ({
        type: 'chat-message',
        payload: message
      }))
    }
  })

  // ── Drive (danger scope) ──────────────────────────────────────
  registry.register({
    method: 'agents.createChat',
    scope: 'agents.run',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const names = deps.agentNames()
      const name = args.agent === undefined ? names[0] : String(args.agent)
      if (!name || !names.includes(name)) {
        throw new ApiError(`unknown agent: ${String(args.agent ?? '(none configured)')}`, 'invalid')
      }
      const title = args.title === undefined ? undefined : String(args.title)
      const chat = deps.createInstance(worktree.id, name, title)
      return { chatId: `${name}/${chat.id}` }
    }
  })

  registry.register({
    method: 'agents.send',
    scope: 'agents.run',
    describe: (args) => `send to agent chat ${String(args.chatId ?? '')}`,
    handler: async (args, context) => {
      const ref = parseChatRef(args.chatId)
      const worktree = context.worktreeFor(args)
      await deps.send(worktree.id, ref.name, String(args.message ?? ''), ref.chatId)
    }
  })

  registry.register({
    method: 'agents.stop',
    scope: 'agents.run',
    handler: async (args, context) => {
      const ref = parseChatRef(args.chatId)
      const worktree = context.worktreeFor(args)
      await deps.stop(worktree.id, ref.name, ref.chatId)
    }
  })

  registry.register({
    method: 'agents.cancelQueued',
    scope: 'agents.run',
    handler: async (args, context) => {
      const ref = parseChatRef(args.chatId)
      const worktree = context.worktreeFor(args)
      deps.cancelQueued(worktree.id, ref.name, ref.chatId, String(args.queueId ?? ''))
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
      deps.sendChatAs(worktree.id, { kind: 'agent', name: context.client.key }, text)
    }
  })
}

function matchesChat(
  event: ApiEvent,
  worktreeId: string,
  ref: ChatRef
): boolean {
  const payload = event.payload as { worktreeId?: string; name?: string; chatId?: string }
  return (
    payload.worktreeId === worktreeId && payload.name === ref.name && payload.chatId === ref.chatId
  )
}
