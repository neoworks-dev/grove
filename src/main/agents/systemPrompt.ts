// The system prompt grove gives an agent, built the way pi builds its own.
//
// A short preamble, then tagged sections: one line per tool, the rules, who the
// agent is and who else is working, and where it runs. The tools carry the
// rest — their descriptions say how to use them, and each adds the few rules
// it needs, so a tool the session does not have costs nothing here.
//
// Grove mode runs on the whole prompt in place of the harness's. A harness on
// its own prompt gets only grove's part appended: grove's tools, their rules
// and the agent's context.

import type { GroveTool } from './harness'
import type { AgentPeer } from './roster'

export interface SystemPromptContext {
  /** The id other agents address this session by. */
  agentId: string
  /** The session's title, which the user can change at any time. */
  title: string
  /** Everyone in the worktree, including this session. */
  peers: AgentPeer[]
  /** The agent that spawned this one and the ones it spawned, when they work in other worktrees. */
  relatives: AgentPeer[]
}

/** Where a grove mode session runs. */
export interface PromptEnvironment {
  workspaceRoot: string
  platform: string
  today: string
}

const GROVE =
  'Grove, an editor where agents work in parallel git worktrees and the user reviews their changes as diffs'

// Rules grove mode adds to what its tools bring.
const WORKING_RULES = [
  'Match the surrounding code; change only what the task needs',
  'Do not commit, push, reset or delete work unless the user asks',
  'If the task is ambiguous in a way that changes the outcome, ask; otherwise pick the sensible default and say which',
  'Be concise in your responses',
  'Show file paths as path:line'
]

/** The whole prompt for a grove mode session, around the session's context sections. */
export function groveModePrompt(
  tools: GroveTool[],
  context: string,
  environment: PromptEnvironment
): string {
  return joinSections([
    `You are an expert coding assistant operating inside ${GROVE}. You help users by reading files, searching code, running commands, editing code, and writing new files.`,
    section('tools', toolLines(tools)),
    section('rules', rules(tools, WORKING_RULES)),
    context,
    section('environment', environmentLines(environment))
  ])
}

/** What a harness running on its own prompt has appended: grove's tools, their rules, the context. */
export function groveAddendum(tools: GroveTool[], context: string): string {
  return joinSections([
    `You are running inside ${GROVE}.`,
    section('grove_tools', toolLines(tools)),
    section('grove_rules', rules(tools, [])),
    context
  ])
}

/** Who the agent is here and who else is working: the `agent` section. */
export function agentSection(context: SystemPromptContext): string {
  const lines = [`You are "${context.title}", id ${context.agentId}. Other agents address you by id.`]
  const others = context.peers.filter((peer) => peer.agentId !== context.agentId)
  if (others.length > 0) {
    lines.push('Other agents in this worktree:')
    for (const peer of others) {
      lines.push(`- ${peer.agentId}: "${peer.title}" (${peer.harness}, ${peer.model || 'default model'})`)
    }
  }
  if (context.relatives.length > 0) {
    lines.push('Agents working with you from other worktrees:')
    for (const peer of context.relatives) {
      lines.push(`- ${peer.agentId}: "${peer.title}" in ${peer.workspaceRoot}`)
    }
  }
  return section('agent', lines.join('\n'))
}

/** Content wrapped in a tag of its name, or nothing when there is no content. */
export function section(name: string, content: string): string {
  if (content.trim().length === 0) return ''
  return `<${name}>\n${content.trim()}\n</${name}>`
}

/** The parts of a prompt, empty ones left out, a blank line apart. */
function joinSections(sections: string[]): string {
  return sections.filter((part) => part.trim().length > 0).join('\n\n')
}

/** One line per tool, pi's `- name: what it does`. */
function toolLines(tools: GroveTool[]): string {
  return tools.map((tool) => `- ${tool.name}: ${tool.summary.replace(/\.$/, '')}`).join('\n')
}

/** The tools' own rules in the order the tools come, then the fixed ones, each said once. */
function rules(tools: GroveTool[], fixed: string[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  const candidates: string[] = []
  for (const tool of tools) {
    if (tool.promptGuidelines) candidates.push(...tool.promptGuidelines)
  }
  candidates.push(...fixed)
  for (const rule of candidates) {
    if (seen.has(rule)) continue
    seen.add(rule)
    lines.push(`- ${rule}`)
  }
  return lines.join('\n')
}

/** Where the session runs, one fact a line. */
function environmentLines(environment: PromptEnvironment): string {
  return [
    `cwd: ${environment.workspaceRoot}`,
    `platform: ${environment.platform}`,
    `date: ${environment.today}`
  ].join('\n')
}
