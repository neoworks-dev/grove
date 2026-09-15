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
  /** The name other agents address this session by. */
  name: string
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
    `Other agents address you as "${context.name}".`
  ].join(' ')
}

function roster(context: SystemPromptContext): string {
  const others = context.peers.filter((peer) => peer.name !== context.name)
  if (others.length === 0) {
    return 'No other agent is working in this worktree right now. `list_agents` tells you when one is.'
  }
  const lines = others.map(
    (peer) => `- ${peer.name} (${peer.harness}, ${peer.model || 'default model'})`
  )
  return ['Also working in this worktree:', ...lines].join('\n')
}

function coordination(context: SystemPromptContext): string {
  return [
    'Coordinating with them:',
    '- `list_agents` — who is here, what they run on, and whether they are busy. Check before assuming you are alone.',
    '- `send_message` — say something to one of them by name, or to the room with no name. A named message interrupts them, so it lands whether or not they think to look.',
    '- `read_messages` — the channel so far. Messages addressed to you arrive on their own; this is for the rest.',
    `- \`spawn_agent\` — start another agent here and give it a task, on any of: ${context.harnesses.join(', ')}. The user is asked before one starts.`,
    '',
    'When work spans several agents: say who does what before starting, address people by the name `list_agents` reports, and report your result back to whoever asked for it. An agent you spawn cannot see this conversation — put everything it needs in its prompt, and tell it to message you by name when it is done.'
  ].join('\n')
}
