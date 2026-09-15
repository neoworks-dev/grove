// What grove tells an agent about the place it is working in.
//
// A harness's own system prompt describes how to be a coding agent; this adds
// the part only grove knows — that the worktree is shared, who else is in it,
// what the agent is called there, and which of grove's tools are for talking to
// the others. Without it the inter-agent tools are just four unexplained entries
// in a tool list, and models leave them alone.
//
// Built per run rather than stored as a constant: the roster changes between
// runs, and an agent that is told the wrong names cannot address anyone.

import type { AgentPeer } from './roster'

export interface SystemPromptContext {
  /** The id other agents address this session by. */
  agentId: string
  /** The session's title, which the user can change at any time. */
  title: string
  workspaceRoot: string
  /** Everyone in the worktree, including this session. */
  peers: AgentPeer[]
  /** The runtimes a spawned agent can run on. */
  harnesses: string[]
}

/**
 * grove's addition to the harness's own system prompt.
 *
 * Kept to what changes behaviour: the agent's name, who is already here, and the
 * two rules that make a hand-off work — address by name, and report back.
 */
export function groveSystemPrompt(context: SystemPromptContext): string {
  const sections = [
    identity(context),
    roster(context),
    coordination(context),
    'Everything above is grove, the editor hosting this session. The user sees the same channel you post on.'
  ]
  return sections.join('\n\n')
}

function identity(context: SystemPromptContext): string {
  return [
    `You are running inside grove, in the worktree ${context.workspaceRoot}.`,
    `You are "${context.title}", and other agents address you by the id ${context.agentId}.`
  ].join(' ')
}

function roster(context: SystemPromptContext): string {
  const others = context.peers.filter((peer) => peer.agentId !== context.agentId)
  if (others.length === 0) {
    return 'No other agent is working in this worktree right now. `list_agents` tells you when one is.'
  }
  const lines = others.map(
    (peer) =>
      `- ${peer.agentId} — "${peer.title}" (${peer.harness}, ${peer.model || 'default model'})`
  )
  return ['Also working in this worktree, id first:', ...lines].join('\n')
}

function coordination(context: SystemPromptContext): string {
  return [
    'Coordinating with them:',
    '- `list_agents` — who is here, what they run on, and whether they are busy. Check before assuming you are alone.',
    '- `send_message` — say something to one of them by id, or to the room with no addressee. An addressed message interrupts them, so it lands whether or not they think to look.',
    '- `read_messages` — the channel so far. Messages addressed to you arrive on their own; this is for the rest.',
    `- \`spawn_agent\` — start another agent here and give it a task, on any of: ${context.harnesses.join(', ')}. The user is asked before one starts.`,
    '- `list_runtimes` — what those runtimes can run: whether each is authenticated, the models it offers and the one it defaults to. Check it before naming a model, rather than guessing an id.',
    '',
    `When work spans several agents: say who does what before starting, address them by the id \`list_agents\` reports — titles are the user's to change, ids are not — and report your result back to whoever asked for it. An agent you spawn cannot see this conversation, so put everything it needs in its prompt; what it says at the end of each of its turns reaches you on its own, and it can also message you at ${context.agentId}.`
  ].join('\n')
}
