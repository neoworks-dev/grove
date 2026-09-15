// grove's own tools, offered to every harness that can host them.
//
// These used to be extensions loaded into the agent server, which meant they
// could not call back into grove and had to reach it through files. Now they run
// in grove's own process, so `send_message` posts on the worktree channel
// directly and `set_phase` publishes a surface on the session's event log.
//
// Each harness adapter translates these into whatever its SDK calls a tool:
// an in-process MCP server for Claude, `defineTool` for pi. A harness that
// cannot host tools is given none and loses only the features they add.

import type { OpenFileTarget } from '../../shared/agents'
import type { WorktreeChatMessage } from '../../shared/types'
import type { WorktreeChannel } from '../worktreeChannel'
import type { GroveTool } from './harness'
import { signatureOf, type AgentPeer, type AgentRoster } from './roster'

// The surface id the intro pane watches. Changing it means changing
// src/renderer/src/lib/intro.svelte.ts.
const INTRO_SURFACE_ID = 'grove.intro'

// Kept in step with INTRO_PHASES in src/renderer/src/lib/intro/prompt.ts.
const INTRO_PHASES = ['explore', 'interview', 'example', 'feedback', 'config', 'done']

// Agent-to-agent chatter can loop; a ceiling per minute keeps a runaway cheap.
const MAX_SENDS_PER_MINUTE = 30
const MINUTE_MS = 60_000

export interface GroveToolOptions {
  chat: WorktreeChannel
  /** Who else is working in this worktree, and how to reach or start one. */
  roster: AgentRoster
  now?: () => number
}

/**
 * The review protocol.
 *
 * `policy: 'ask'` is the whole mechanism: the harness parks its loop on the
 * confirmation, grove raises the diff, and answering the approval is what
 * releases the agent. `execute` therefore decides nothing — by the time it runs
 * the call has already been allowed, and the verdict arrives as a message.
 */
function requestReviewTool(): GroveTool {
  return {
    name: 'request_review',
    summary: 'Ask the user to review the changes you have made so far.',
    description:
      'Submit the file changes you have made so far for review. The user reads them as a diff ' +
      'and may revert individual hunks or comment on them; you are told the outcome before you ' +
      'continue. Call this when you have finished a coherent piece of work, not after every ' +
      'edit, and summarize what you changed and why.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One or two sentences on what you changed and why, for the review header.'
        }
      },
      required: ['summary'],
      additionalProperties: false
    },
    policy: 'ask',
    display: { label: '{summary}', input: 'hidden', result: 'text' },

    execute() {
      return { content: 'Submitted for review.' }
    }
  }
}

/**
 * The onboarding stepper.
 *
 * The intro pane follows a fixed set of phases. Reporting one publishes a
 * surface on the session's own event log, which is the stream the pane is
 * already watching.
 */
function setPhaseTool(): GroveTool {
  return {
    name: 'set_phase',
    summary: 'Report which onboarding phase you are entering.',
    description:
      'Report the onboarding phase you are entering, so the introduction page can show ' +
      'progress. Call this as you begin each phase, not after finishing it.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          enum: INTRO_PHASES,
          description: 'The onboarding phase you are entering.'
        }
      },
      required: ['phase'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{phase}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const phase = String(input.phase)
      context.surface(INTRO_SURFACE_ID, 'panel', {
        kind: 'text',
        text: phase,
        fallbackText: phase
      })
      return { content: `Phase set to ${phase}.` }
    }
  }
}

/**
 * The editor handoff.
 *
 * An answer that names files is worth more with those files on screen, so the
 * agent can put them there itself instead of leaving the user to open each one.
 * The renderer opens them in the order given, so the first entry is the one it
 * leaves focused.
 */
function openFilesTool(): GroveTool {
  return {
    name: 'open_files',
    summary: 'Open files in the user’s editor.',
    description:
      'Open files in the editor the user is looking at, optionally at a line. Call this ' +
      'whenever your answer points at code — where something is defined, where it is used, ' +
      'what you changed — so the user lands on it instead of having to search for it. Put the ' +
      'most relevant file first; that is the one left in view. This does not read the files, ' +
      'so keep using your own read tools for that.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'The files to open, most relevant first.',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Absolute path, or relative to the workspace root.'
              },
              line: { type: 'number', description: 'Optional 1-based line to reveal.' }
            },
            required: ['path'],
            additionalProperties: false
          }
        }
      },
      required: ['files'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{files}', input: 'hidden', result: 'hidden' },

    execute(input, context) {
      const targets = openFileTargets(input.files)
      if (targets.length === 0) return { content: 'No files to open.', isError: true }
      context.openFiles(targets)
      return { content: `Opened ${targets.map((target) => target.path).join(', ')}.` }
    }
  }
}

/** Tool inputs arrive unvalidated; entries without a usable path are dropped. */
function openFileTargets(value: unknown): OpenFileTarget[] {
  if (!Array.isArray(value)) return []
  const targets: OpenFileTarget[] = []
  for (const entry of value) {
    const path = pathOf(entry)
    if (path === null) continue
    const line = lineOf(entry)
    if (line === null) targets.push({ path })
    else targets.push({ path, line })
  }
  return targets
}

function pathOf(entry: unknown): string | null {
  if (typeof entry === 'string' && entry.length > 0) return entry
  if (typeof entry !== 'object' || entry === null) return null
  const path = (entry as Record<string, unknown>).path
  if (typeof path !== 'string' || path.length === 0) return null
  return path
}

function lineOf(entry: unknown): number | null {
  if (typeof entry !== 'object' || entry === null) return null
  const line = (entry as Record<string, unknown>).line
  if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) return null
  return Math.floor(line)
}

/**
 * Talking to the other agents.
 *
 * Everything goes through the worktree's shared channel, so the user reads the
 * same conversation the agents do. A message with a named addressee is also
 * pushed straight into that agent's session — waiting for it to think of calling
 * `read_messages` would make handing work over a matter of luck.
 */
function chatTools(options: GroveToolOptions): GroveTool[] {
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
    description:
      "Post a message on this worktree's shared channel, which the user and every other agent " +
      'working here can read. Put an agent id in "to" (the id `list_agents` reports, not its ' +
      "title) and the message is delivered into that agent's conversation as well, interrupting " +
      'what it is doing; leave "to" out to address the room. Use this to hand work over, ask for ' +
      'a result, or report one back — not for routine progress.',
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

      await options.chat.post(
        context.workspaceRoot,
        { kind: 'agent', name: from, instanceId: context.sessionId },
        text,
        addresseeOf(target)
      )
      if (target.kind !== 'agent') return { content: 'Posted on the channel.' }
      if (target.peer.sessionId === context.sessionId) {
        return { content: 'That is you; the message was posted on the channel only.' }
      }

      await options.roster.deliver(target.peer.sessionId, from, text)
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
      'request. Address agents by id — a title can change, an id cannot. Call this before ' +
      'handing work over, and again when an answer is overdue.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    policy: 'allow',
    display: { label: 'agents', input: 'hidden', result: 'list' },

    async execute(_input, context) {
      const peers = await options.roster.peers(context.workspaceRoot)
      if (peers.length === 0) return { content: 'No agents are running in this worktree.' }
      return { content: peers.map((peer) => describePeer(peer, context.sessionId)).join('\n') }
    }
  }

  return [send, read, list, spawnTool(options)]
}

/**
 * Starting another agent.
 *
 * The only grove tool that asks before it runs: a spawned agent costs tokens and
 * writes files on its own account, so the user decides whether one starts, the
 * same way they decide on any other consequential call.
 */
function spawnTool(options: GroveToolOptions): GroveTool {
  return {
    name: 'spawn_agent',
    summary: 'Start another agent in this worktree and give it a task.',
    description:
      'Start a new agent session in this worktree and hand it a task. Use it to run work in ' +
      'parallel, or to put a job on a runtime better suited to it than yours. Whatever it says ' +
      'at the end of each of its turns is delivered back to you, and it shares the worktree and ' +
      'the message channel with you. It does not see this conversation: the prompt has to carry ' +
      'everything it needs.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A short title for the new agent, describing the job it is being given.'
        },
        prompt: { type: 'string', description: 'The task, in full.' },
        harness: {
          type: 'string',
          description: `The runtime to run it on. One of: ${options.roster.harnessIds().join(', ')}.`
        },
        model: { type: 'string', description: 'Optional model id for the new session.' }
      },
      required: ['title', 'prompt'],
      additionalProperties: false
    },
    policy: 'ask',
    display: { label: '{title}', input: 'message', result: 'text' },

    async execute(input, context) {
      const title = String(input.title).trim()
      const prompt = String(input.prompt)
      if (title.length === 0 || prompt.length === 0) {
        return { content: 'A spawned agent needs both a title and a prompt.', isError: true }
      }

      const harness = stringOrNothing(input.harness)
      if (harness && !options.roster.harnessIds().includes(harness)) {
        const known = options.roster.harnessIds().join(', ')
        return { content: `Unknown harness "${harness}". Mounted: ${known}.`, isError: true }
      }

      const peer = await options.roster.spawn({
        workspaceRoot: context.workspaceRoot,
        title,
        harness,
        model: stringOrNothing(input.model),
        prompt,
        parentSessionId: context.sessionId
      })
      return {
        content:
          `Started "${peer.title}" on ${peer.harness}. Address it as ${peer.agentId}; ` +
          'what it says at the end of each of its turns is delivered to you.'
      }
    }
  }
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

function stateOf(peer: AgentPeer): string {
  if (peer.waiting) return 'held on a permission request'
  if (peer.status === 'running') return 'working'
  return peer.status
}

/** Tool inputs arrive unvalidated; an addressee that is not a string has none. */
function stringOrNothing(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value
}

/** Every tool grove contributes, in the order they are offered to a harness. */
export function groveTools(options: GroveToolOptions): GroveTool[] {
  return [requestReviewTool(), setPhaseTool(), openFilesTool(), ...chatTools(options)]
}
