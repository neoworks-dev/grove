// Talking to the other agents over the worktree's shared channel.

import type { WorktreeChatMessage } from '../../../shared/types'
import type { WorktreeChannel } from '../../worktreeChannel'
import type { GroveTool } from '../harness'
import { signatureOf, type AgentPeer, type AgentRoster } from '../roster'
import { stringOrNothing } from './toolInput'

// Agent-to-agent chatter can loop; a ceiling per minute keeps a runaway cheap.
const MAX_SENDS_PER_MINUTE = 30
const MINUTE_MS = 60_000

export interface ChatToolOptions {
  chat: WorktreeChannel
  /** Who else is working in this worktree, and how to reach one. */
  roster: AgentRoster
  now?: () => number
}

/**
 * Talking to the other agents.
 *
 * Everything goes through the worktree's shared channel, so the user reads the
 * same conversation the agents do. A message with a named addressee is also
 * pushed straight into that agent's session — waiting for it to think of calling
 * `read_messages` would make handing work over a matter of luck.
 */
export function chatTools(options: ChatToolOptions): GroveTool[] {
  const now = options.now ?? ((): number => Date.now())
  const sendTimes: number[] = []

  function withinRateLimit(): boolean {
    const timestamp = now()
    while (sendTimes.length > 0 && timestamp - sendTimes[0] > MINUTE_MS) sendTimes.shift()
    if (sendTimes.length >= MAX_SENDS_PER_MINUTE) return false
    sendTimes.push(timestamp)
    return true
  }

  const send: GroveTool = {
    name: 'send_message',
    summary: 'Send a message to another agent, or to everyone in this worktree.',
    promptGuidelines: ['Address agents by id, not by title', 'Report results back to whoever asked for them'],
    description:
      "Post a message on this worktree's shared channel, which the user and every other agent " +
      'working here can read. Put an agent id in "to" (the id `list_agents` reports, not its ' +
      "title) and the message is delivered into that agent's conversation as well, interrupting " +
      'what it is doing; leave "to" out to address the room. An agent idle for over an hour is ' +
      'not woken: the message is held until the user decides, and you are told how they did. ' +
      "An id reaches an agent in another worktree too, and the message is then posted on that " +
      "worktree's channel as well. Use this to hand work over, ask for a result, or report one " +
      'back — not for routine progress.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send.' },
        to: {
          type: 'string',
          description: 'The agent id to address, as `list_agents` reports it.'
        }
      },
      required: ['text'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{text}', input: 'message', result: 'text' },

    async execute(input, context) {
      if (!withinRateLimit()) {
        return { content: 'Rate limited: too many messages in the last minute.', isError: true }
      }
      const text = String(input.text)
      const from = await options.roster.signatureOf(context.sessionId)
      const addressee = stringOrNothing(input.to)

      const target = await resolveAddressee(options.roster, context.workspaceRoot, addressee)
      if (target.kind === 'unknown') return target.error

      await postOnChannels(options.chat, context, from, text, target)
      if (target.kind !== 'agent') return { content: 'Posted on the channel.' }
      if (target.peer.sessionId === context.sessionId) {
        return { content: 'That is you; the message was posted on the channel only.' }
      }

      const outcome = await options.roster.deliver(target.peer.sessionId, from, text, context.sessionId)
      if (outcome.kind === 'held') return { content: heldNotice(signatureOf(target.peer), outcome.idleSince) }
      return { content: `Delivered to ${signatureOf(target.peer)}.` }
    }
  }

  const read: GroveTool = {
    name: 'read_messages',
    summary: "Read recent messages from this worktree's shared channel.",
    description:
      "Read what the user and any other agents have posted on this worktree's shared channel. " +
      'Pass "since" to read only what is new to you. Messages addressed to you are delivered ' +
      'into this conversation as they are sent, so this is for catching up on the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Only messages after this epoch-ms timestamp.' }
      },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: 'channel', input: 'hidden', result: 'list' },

    async execute(input, context) {
      const since = typeof input.since === 'number' ? input.since : undefined
      const messages = await options.chat.list(context.workspaceRoot, since)
      if (messages.length === 0) return { content: 'No messages.' }
      return { content: messages.map(channelLine).join('\n') }
    }
  }

  const list: GroveTool = {
    name: 'list_agents',
    summary: 'List the other agents working in this worktree.',
    description:
      'List every agent session in this worktree: the id to address it by, its title, the ' +
      'runtime it runs on, its model, and whether it is working, idle or held on a permission ' +
      'request. The agent that spawned you and the ones you spawned are listed too when they ' +
      'work in another worktree; set "all_worktrees" to list everyone in every worktree. ' +
      'Address agents by id — a title can change, an id cannot. Call this before handing work ' +
      'over, and again when an answer is overdue.',
    inputSchema: {
      type: 'object',
      properties: {
        all_worktrees: {
          type: 'boolean',
          description: 'List the agents in every worktree, not only yours. Default false.'
        }
      },
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: 'agents', input: 'hidden', result: 'list' },

    async execute(input, context) {
      const here = await options.roster.peers(context.workspaceRoot)
      const elsewhere = await agentsElsewhere(options.roster, context, input.all_worktrees === true)
      if (here.length === 0 && elsewhere.length === 0) {
        return { content: 'No agents are running in this worktree.' }
      }

      const lines = here.map((peer) => describePeer(peer, context.sessionId))
      if (elsewhere.length > 0) {
        lines.push('In other worktrees:')
        lines.push(...elsewhere.map((peer) => describePeerElsewhere(peer, context.sessionId)))
      }
      return { content: lines.join('\n') }
    }
  }

  return [send, read, list]
}

type Addressee =
  | { kind: 'everyone' }
  | { kind: 'agent'; peer: AgentPeer }
  | { kind: 'unknown'; error: { content: string; isError: true } }

/** Who a message is for, or an error naming the agents that do exist. */
async function resolveAddressee(
  roster: AgentRoster,
  workspaceRoot: string,
  addressee: string | undefined
): Promise<Addressee> {
  if (!addressee) return { kind: 'everyone' }
  const peer = await roster.resolve(workspaceRoot, addressee)
  if (peer) return { kind: 'agent', peer }

  const peers = await roster.peers(workspaceRoot)
  const known = peers.map(signatureOf).join(', ') || 'none'
  return {
    kind: 'unknown',
    error: {
      content: `No agent "${addressee}" in this worktree. Running here: ${known}.`,
      isError: true
    }
  }
}

/**
 * The agents outside the caller's worktree that `list_agents` shows: its
 * relatives by default, everyone when asked.
 */
async function agentsElsewhere(
  roster: AgentRoster,
  context: { sessionId: string; workspaceRoot: string },
  everyWorktree: boolean
): Promise<AgentPeer[]> {
  if (!everyWorktree) return roster.relativesElsewhere(context.sessionId)
  const everyone = await roster.everyone()
  return everyone.filter((peer) => peer.workspaceRoot !== context.workspaceRoot)
}

/**
 * Posts a message on the sender's channel, and on the addressee's as well when
 * it works in another worktree, so the user reading either sees it.
 */
async function postOnChannels(
  chat: WorktreeChannel,
  context: { sessionId: string; workspaceRoot: string },
  from: string,
  text: string,
  target: Addressee
): Promise<void> {
  const sender = { kind: 'agent' as const, name: from, instanceId: context.sessionId }
  await chat.post(context.workspaceRoot, sender, text, addresseeOf(target))
  if (target.kind !== 'agent') return
  if (target.peer.workspaceRoot === context.workspaceRoot) return
  await chat.post(target.peer.workspaceRoot, sender, text, addresseeOf(target))
}

/** The name a message is filed under on the channel. */
function addresseeOf(target: Addressee): string | undefined {
  if (target.kind !== 'agent') return undefined
  return signatureOf(target.peer)
}

/** One channel message, as the model reads it. */
function channelLine(entry: WorktreeChatMessage): string {
  if (!entry.to) return `[${entry.from.name}] ${entry.text}`
  return `[${entry.from.name} → ${entry.to}] ${entry.text}`
}

/** One roster line, as the model reads it. */
function describePeer(peer: AgentPeer, selfSessionId: string): string {
  const parts = [
    peer.agentId,
    peer.title,
    peer.harness,
    peer.model || 'default model',
    stateOf(peer)
  ]
  if (peer.sessionId === selfSessionId) parts.push('you')
  return `- ${parts.join(' · ')}`
}

/** A roster line for an agent in another worktree: where it is, and how it is related. */
function describePeerElsewhere(peer: AgentPeer, selfSessionId: string): string {
  const parts = [describePeer(peer, selfSessionId), `in ${peer.workspaceRoot}`]
  if (peer.parentSessionId === selfSessionId) parts.push('spawned by you')
  return parts.join(' · ')
}

function stateOf(peer: AgentPeer): string {
  if (peer.waiting) return 'held on a permission request'
  if (peer.status === 'running') return 'working'
  return peer.status
}

/**
 * What the sender is told when its message was held: that it has not arrived,
 * why, and that it hears back, so it neither waits on an answer nor resends.
 */
function heldNotice(recipient: string, idleSince: string): string {
  return (
    `Held, not delivered: ${recipient} has been idle since ${idleSince}, and waking it would ` +
    're-read its whole context. The user decides whether to send it; you will be told what they ' +
    'decide. Do not send it again, and do not wait on an answer from it.'
  )
}
