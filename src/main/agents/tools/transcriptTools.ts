// Reading what other agents have been doing, from their transcripts.

import type { GroveTool } from '../harness'
import { signatureOf, type AgentPeer, type AgentRoster } from '../roster'
import {
  renderHit,
  renderLine,
  searchLines,
  transcriptLines,
  type TranscriptLine
} from '../transcript'
import { limitOf, stringOrNothing, unknownAgent } from './toolInput'

/**
 * Reading what other agents have been doing.
 *
 * `read_messages` only sees what someone chose to post on the channel; most of
 * what an agent knows is in its own transcript, which nobody summarized. These
 * two read that log directly — one session in full, or every session in this
 * worktree for a phrase — so an agent can find out what was already tried
 * instead of interrupting the agent that tried it.
 */
export function transcriptTools(roster: AgentRoster): GroveTool[] {
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

      const peer = await roster.resolve(context.workspaceRoot, reference)
      if (!peer) return unknownAgent(reference)

      const lines = await linesOf(roster, peer, input.include_tools === true)
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

      const scope = await searchScope(roster, context.workspaceRoot, input.agent)
      if ('error' in scope) return scope.error

      const limit = limitOf(input.limit, 20)
      const sections: string[] = []
      for (const peer of scope.peers) {
        const lines = await linesOf(roster, peer, input.include_tools === true)
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
  roster: AgentRoster,
  peer: AgentPeer,
  includeTools: boolean
): Promise<TranscriptLine[]> {
  const events = await roster.transcriptOf(peer.sessionId)
  return transcriptLines(events, { includeTools })
}

/** Every agent here, or the one that was named. */
async function searchScope(
  roster: AgentRoster,
  workspaceRoot: string,
  named: unknown
): Promise<{ peers: AgentPeer[] } | { error: { content: string; isError: true } }> {
  const reference = stringOrNothing(named)
  if (!reference) return { peers: await roster.peers(workspaceRoot) }

  const peer = await roster.resolve(workspaceRoot, reference)
  if (!peer) return { error: unknownAgent(reference) }
  return { peers: [peer] }
}
