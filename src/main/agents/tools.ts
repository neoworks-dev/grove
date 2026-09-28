// grove's own tools, offered to every harness that can host them.
//
// These used to be extensions loaded into the agent server, which meant they
// could not call back into grove and had to reach it through files. Now they run
// in grove's own process, so `send_message` posts on the worktree channel
// directly.
//
// Each harness adapter translates these into whatever its SDK calls a tool:
// an in-process MCP server for Claude, `defineTool` for pi. A harness that
// cannot host tools is given none and loses only the features they add.

import type { WorktreeChatMessage } from '../../shared/types'
import type { WorktreeChannel } from '../worktreeChannel'
import type { GroveTool } from './harness'
import { noteTools, type AgentNotes } from './noteTools'
import { showTools, type AgentScreen } from './showTools'
import { findWorktree, worktreeTools, type AgentWorktrees } from './worktreeTools'
import { signatureOf, type AgentPeer, type AgentRoster, type AgentRuntime } from './roster'
import {
  renderHit,
  renderLine,
  searchLines,
  transcriptLines,
  type TranscriptLine
} from './transcript'

// Agent-to-agent chatter can loop; a ceiling per minute keeps a runaway cheap.
const MAX_SENDS_PER_MINUTE = 30
const MINUTE_MS = 60_000

export interface GroveToolOptions {
  chat: WorktreeChannel
  /** Who else is working in this worktree, and how to reach or start one. */
  roster: AgentRoster
  /** Each session's notes list. */
  notes: AgentNotes
  /** What the renderer can put on screen. */
  screen: AgentScreen
  /** The repository's worktrees, to list, create and spawn agents into. */
  worktrees: AgentWorktrees
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

  return [send, read, list, runtimesTool(options), spawnTool(options), ...transcriptTools(options)]
}

/**
 * Reading what other agents have been doing.
 *
 * `read_messages` only sees what someone chose to post on the channel; most of
 * what an agent knows is in its own transcript, which nobody summarized. These
 * two read that log directly — one session in full, or every session in this
 * worktree for a phrase — so an agent can find out what was already tried
 * instead of interrupting the agent that tried it.
 */
function transcriptTools(options: GroveToolOptions): GroveTool[] {
  const read: GroveTool = {
    name: 'read_transcript',
    summary: "Read another agent's conversation.",
    description:
      'Read the conversation of an agent in this worktree: what the user asked it, what it ' +
      'answered, and — with "include_tools" — the calls it made. Pass the agent id from ' +
      '`list_agents`, or your own to re-read your earlier turns. Use this before asking an ' +
      'agent a question its transcript already answers.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The agent id, as `list_agents` reports it.' },
        since: { type: 'number', description: 'Only lines after this event number (`#12` → 12).' },
        limit: {
          type: 'number',
          description: 'How many lines to return, newest last. Default 40.'
        },
        include_tools: {
          type: 'boolean',
          description: 'Include tool calls, their results and shell output. Default false.'
        }
      },
      required: ['agent'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{agent}', input: 'hidden', result: 'text' },

    async execute(input, context) {
      const reference = stringOrNothing(input.agent)
      if (!reference) return { content: 'Name the agent to read.', isError: true }

      const peer = await options.roster.resolve(context.workspaceRoot, reference)
      if (!peer) return unknownAgent(reference)

      const lines = await linesOf(options, peer, input.include_tools === true)
      const after = typeof input.since === 'number' ? input.since : 0
      const wanted = lines.filter((line) => line.seq > after)
      const limit = limitOf(input.limit, 40)
      const shown = wanted.slice(Math.max(0, wanted.length - limit))
      if (shown.length === 0) return { content: `${signatureOf(peer)} has said nothing yet.` }

      const header = `${signatureOf(peer)} — ${shown.length} of ${wanted.length} lines`
      return { content: [header, ...shown.map(renderLine)].join('\n') }
    }
  }

  const search: GroveTool = {
    name: 'search_transcripts',
    summary: 'Search what every agent in this worktree has said.',
    description:
      'Search the conversations of every agent in this worktree for a phrase, yours included. ' +
      'Matching is a case-insensitive substring, and each hit comes back with the agent and the ' +
      'event number to read around with `read_transcript`. Use it to find whether something has ' +
      'already been tried, decided or explained.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The phrase to look for.' },
        agent: { type: 'string', description: 'Search only this agent, by id. Optional.' },
        limit: { type: 'number', description: 'How many hits to return. Default 20.' },
        include_tools: {
          type: 'boolean',
          description: 'Search tool calls and results too. Default false.'
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{query}', input: 'hidden', result: 'list' },

    async execute(input, context) {
      const query = stringOrNothing(input.query)
      if (!query) return { content: 'Name what to search for.', isError: true }

      const scope = await searchScope(options, context.workspaceRoot, input.agent)
      if ('error' in scope) return scope.error

      const limit = limitOf(input.limit, 20)
      const sections: string[] = []
      for (const peer of scope.peers) {
        const lines = await linesOf(options, peer, input.include_tools === true)
        const hits = searchLines(lines, query, limit)
        if (hits.length === 0) continue
        sections.push([`${signatureOf(peer)}:`, ...hits.map(renderHit)].join('\n'))
      }
      if (sections.length === 0) return { content: `No agent has mentioned "${query}".` }
      return { content: sections.join('\n\n') }
    }
  }

  return [read, search]
}

/** The transcript of one peer, folded into readable lines. */
async function linesOf(
  options: GroveToolOptions,
  peer: AgentPeer,
  includeTools: boolean
): Promise<TranscriptLine[]> {
  const events = await options.roster.transcriptOf(peer.sessionId)
  return transcriptLines(events, { includeTools })
}

/** Every agent here, or the one that was named. */
async function searchScope(
  options: GroveToolOptions,
  workspaceRoot: string,
  named: unknown
): Promise<{ peers: AgentPeer[] } | { error: { content: string; isError: true } }> {
  const reference = stringOrNothing(named)
  if (!reference) return { peers: await options.roster.peers(workspaceRoot) }

  const peer = await options.roster.resolve(workspaceRoot, reference)
  if (!peer) return { error: unknownAgent(reference) }
  return { peers: [peer] }
}

function unknownAgent(reference: string): { content: string; isError: true } {
  return {
    content: `No agent here is called "${reference}". Call \`list_agents\` for the ids.`,
    isError: true
  }
}

/** A limit a model wrote: a positive whole number, or the default. */
function limitOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

/**
 * What a spawned agent could be run on.
 *
 * Asked for rather than described: which runtimes are authenticated and which
 * models they offer changes while grove runs, and a list written into
 * `spawn_agent`'s description when the session started would go stale.
 */
function runtimesTool(options: GroveToolOptions): GroveTool {
  return {
    name: 'list_runtimes',
    summary: 'List the runtimes and models a new agent can be started on.',
    description:
      'List every agent runtime grove has mounted: whether it can run right now, whether it can ' +
      'talk back to you, the models it offers and the one it would pick for itself. Call this ' +
      'before `spawn_agent` when you care which runtime or model does the work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    policy: 'allow',
    display: { label: 'runtimes', input: 'hidden', result: 'list' },

    async execute() {
      const runtimes = await options.roster.runtimes()
      if (runtimes.length === 0) return { content: 'No runtimes are mounted.', isError: true }
      return { content: runtimes.map(describeRuntime).join('\n') }
    }
  }
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
      'everything it needs. Set `removeWhenDone` for a one-shot helper, so its conversation is ' +
      'cleared away once it has answered. Set `worktree` to start it in another worktree ' +
      'instead — one per task, made with `create_worktree`; it still reports back to you, but ' +
      "works on that branch and shares that worktree's channel rather than yours.",
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
        model: {
          type: 'string',
          description:
            'Optional model id, as `list_runtimes` reports it for the chosen runtime. The ' +
            "runtime's own default is used when this is left out."
        },
        worktree: {
          type: 'string',
          description:
            'Start it in this worktree instead of yours: a branch or path as `list_worktrees` ' +
            'reports it.'
        },
        removeWhenDone: {
          type: 'boolean',
          description:
            'Delete the agent once it has reported back, instead of leaving its conversation ' +
            'open. Use it for one-shot work you will not need to follow up on; the agent is ' +
            'gone after its first answer, so you cannot message it afterwards.'
        }
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

      const model = stringOrNothing(input.model)
      const modelError = await checkModel(options.roster, context.sessionId, harness, model)
      if (modelError) return modelError

      const workspace = await spawnWorkspace(
        options.worktrees,
        context.workspaceRoot,
        input.worktree
      )
      if ('error' in workspace) return workspace.error

      const peer = await options.roster.spawn({
        workspaceRoot: workspace.root,
        title,
        harness,
        model,
        prompt,
        parentSessionId: context.sessionId,
        removeWhenDone: input.removeWhenDone === true
      })
      let where = ''
      if (workspace.root !== context.workspaceRoot) where = ` in ${workspace.root}`
      if (input.removeWhenDone === true) {
        return {
          content:
            `Started "${peer.title}" on ${peer.harness}${where}. Its answer is delivered to you and ` +
            'the agent is removed afterwards, so do not plan on messaging it.'
        }
      }
      return {
        content:
          `Started "${peer.title}" on ${peer.harness}${where}. Address it as ${peer.agentId}; ` +
          'what it says at the end of each of its turns is delivered to you.'
      }
    }
  }
}

/**
 * Where a spawned agent runs: the caller's worktree, or the one it named.
 *
 * A named worktree that does not exist is refused rather than created, so a
 * typo cannot start a branch nobody asked for.
 */
async function spawnWorkspace(
  worktrees: AgentWorktrees,
  callerRoot: string,
  named: unknown
): Promise<{ root: string } | { error: { content: string; isError: true } }> {
  const reference = stringOrNothing(named)
  if (!reference) return { root: callerRoot }

  const all = await worktrees.list()
  const worktree = findWorktree(all, reference)
  if (worktree) return { root: worktree.path }

  const known = all.map((entry) => entry.branch).join(', ')
  return {
    error: {
      content: `No worktree "${reference}". Existing: ${known}. Make one with \`create_worktree\` first.`,
      isError: true
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

/**
 * A model the chosen runtime cannot run is refused before a session exists.
 *
 * Spawning on one and letting it fail leaves a dead session in the strip for the
 * user to clear up, and tells the agent nothing about what it should have asked
 * for.
 */
async function checkModel(
  roster: AgentRoster,
  sessionId: string,
  harness: string | undefined,
  model: string | undefined
): Promise<{ content: string; isError: true } | null> {
  if (!model) return null
  const target = harness ?? (await roster.agentHarnessOf(sessionId))
  if (!target) return null

  const models = await roster.modelsOf(target)
  if (models.length === 0) return null
  if (models.some((entry) => entry.model === model)) return null

  const known = models.map((entry) => entry.model).join(', ')
  return {
    content: `${target} cannot run "${model}". It offers: ${known}.`,
    isError: true
  }
}

/** One runtime, as the model reads it. */
function describeRuntime(runtime: AgentRuntime): string {
  const state = runtime.available ? 'ready' : `unavailable (${runtime.detail ?? 'not set up'})`
  const models = runtime.models.map((entry) => entry.model).join(', ') || 'none reported'
  const parts = [`${runtime.id} · ${state}`, `models: ${models}`]
  if (runtime.default) parts.push(`default: ${runtime.default.model}`)
  if (!runtime.talks) parts.push('cannot message you back')
  return `- ${parts.join(' · ')}`
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
  return [
    requestReviewTool(),
    ...showTools(options.screen),
    ...noteTools(options.notes),
    ...chatTools(options),
    ...worktreeTools(options.worktrees)
  ]
}
