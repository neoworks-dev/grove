// Starting other agents, and finding out what they can be run on.

import type { SpawnTarget, ThinkingLevel } from '../../../shared/agents'
import type { GroveTool } from '../harness'
import type { AgentRoster, AgentRuntime } from '../roster'
import { findWorktree, type AgentWorktrees } from './worktreeTools'
import { stringOrNothing } from './toolInput'

/**
 * What a spawned agent could be run on.
 *
 * Asked for rather than described: which runtimes are authenticated and which
 * models they offer changes while grove runs, and a list written into
 * `spawn_agent`'s description when the session started would go stale.
 */
export function runtimesTool(roster: AgentRoster): GroveTool {
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
      const runtimes = await roster.runtimes()
      if (runtimes.length === 0) return { content: 'No runtimes are mounted.', isError: true }
      return { content: runtimes.map(describeRuntime).join('\n') }
    }
  }
}

// The efforts a spawn may ask for. Leaving it out is the runtime's own default,
// which is what the composer's `off` means, so `off` is not offered.
const SPAWN_EFFORTS: ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Starting another agent.
 *
 * The only grove tool that asks before it runs: a spawned agent costs tokens and
 * writes files on its own account, so the user decides whether one starts, the
 * same way they decide on any other consequential call.
 */
export function spawnTool(roster: AgentRoster, worktrees: AgentWorktrees): GroveTool {
  return {
    name: 'spawn_agent',
    summary: 'Start another agent in this worktree and give it a task.',
    promptGuidelines: ['Give a spawned agent everything it needs in its prompt; it cannot see this conversation'],
    description:
      'Start an agent on a task, to work in parallel or on a better-suited runtime. What it ' +
      'says at the end of each turn is delivered to you. In another worktree it still reports ' +
      'to you, and you can message each other by id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the job.' },
        prompt: { type: 'string', description: 'The whole task.' },
        harness: { type: 'string', enum: roster.harnessIds() },
        model: { type: 'string', description: "Model id from list_runtimes; else the runtime's default." },
        provider: {
          type: 'string',
          description: 'Provider from list_runtimes, when several serve the model.'
        },
        effort: {
          type: 'string',
          enum: SPAWN_EFFORTS,
          description: "Reasoning effort; else the runtime's default."
        },
        worktree: { type: 'string', description: 'Branch or path from list_worktrees, to start it there.' },
        removeWhenDone: {
          type: 'boolean',
          description: 'Remove it after its first answer, for one-shot work.'
        }
      },
      required: ['title', 'prompt'],
      additionalProperties: false
    },
    policy: 'ask',
    display: { title: 'Start agent', label: '{title}', input: 'message', result: 'text' },

    // The approval shows, and lets the user change, what the agent will run on.
    async describe(input, context) {
      const spawn: SpawnTarget = await roster.spawnTarget(context.sessionId, {
        harness: stringOrNothing(input.harness),
        provider: stringOrNothing(input.provider),
        model: stringOrNothing(input.model),
        effort: effortOf(input.effort)
      })
      return { _meta: { grove: { spawn } } }
    },

    async execute(input, context) {
      const title = String(input.title).trim()
      const prompt = String(input.prompt)
      if (title.length === 0 || prompt.length === 0) {
        return { content: 'A spawned agent needs both a title and a prompt.', isError: true }
      }

      const harness = stringOrNothing(input.harness)
      if (harness && !roster.harnessIds().includes(harness)) {
        const known = roster.harnessIds().join(', ')
        return { content: `Unknown harness "${harness}". Mounted: ${known}.`, isError: true }
      }

      const effort = effortOf(input.effort)
      if (input.effort !== undefined && !effort) {
        return {
          content: `Unknown effort ${JSON.stringify(input.effort)}. One of: ${SPAWN_EFFORTS.join(', ')}.`,
          isError: true
        }
      }

      const model = stringOrNothing(input.model)
      const modelError = await checkModel(roster, context.sessionId, harness, model)
      if (modelError) return modelError

      const workspace = await spawnWorkspace(worktrees, context.workspaceRoot, input.worktree)
      if ('error' in workspace) return workspace.error

      const peer = await roster.spawn({
        workspaceRoot: workspace.root,
        title,
        harness,
        model,
        provider: stringOrNothing(input.provider),
        thinkingLevel: effort,
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

/** A spawn's effort, when the call asked for one grove knows. */
function effortOf(value: unknown): ThinkingLevel | undefined {
  return SPAWN_EFFORTS.find((level) => level === value)
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
