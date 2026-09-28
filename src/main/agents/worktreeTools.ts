// The repository's worktrees, as an agent reaches them.
//
// With these an agent can lay out parallel work itself: make a worktree per
// task and start an agent in each with `spawn_agent`'s `worktree`, instead of
// the user preparing every one by hand.

import type { Worktree } from '../../shared/types'
import type { GroveTool } from './harness'

/** What grove does with worktrees on an agent's behalf. */
export interface AgentWorktrees {
  list(): Promise<Worktree[]>
  /** Checks out a new branch in a new worktree and runs the repo's setup in it. */
  create(options: { branch: string; base?: string }): Promise<Worktree>
}

/** `list_worktrees` and `create_worktree`, working through `worktrees`. */
export function worktreeTools(worktrees: AgentWorktrees): GroveTool[] {
  const list: GroveTool = {
    name: 'list_worktrees',
    summary: "List the repository's worktrees.",
    description:
      'List every worktree of this repository: its branch, its path, and which one you are ' +
      'in. Pass a branch or path from here as `worktree` to `spawn_agent` to start an agent ' +
      'in that worktree.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    policy: 'allow',
    display: { label: 'worktrees', input: 'hidden', result: 'list' },

    async execute(_input, context) {
      const all = await worktrees.list()
      if (all.length === 0) return { content: 'No worktrees.' }
      const lines = all.map((worktree) => describeWorktree(worktree, context.workspaceRoot))
      return { content: lines.join('\n') }
    }
  }

  const create: GroveTool = {
    name: 'create_worktree',
    summary: 'Create a new worktree on a new branch.',
    description:
      'Create a new branch off a base and check it out in a new worktree, running the ' +
      "repository's setup commands in it the way the user's New Worktree dialog does. Use it " +
      'to give a separate task — an issue, say — a branch of its own, then start an agent ' +
      'there with `spawn_agent` and `worktree`. Name the branch the way the repository names ' +
      'them.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'The new branch, which also names the worktree.' },
        base: {
          type: 'string',
          description:
            "The branch to start from. The repository's default base branch when left out."
        }
      },
      required: ['branch'],
      additionalProperties: false
    },
    policy: 'ask',
    display: { label: '{branch}', input: 'hidden', result: 'text' },

    async execute(input) {
      const branch = stringOrNothing(input.branch)
      if (!branch) return { content: 'Name the branch to create.', isError: true }

      const existing = findWorktree(await worktrees.list(), branch)
      if (existing) {
        return {
          content: `"${branch}" is already checked out at ${existing.path}.`,
          isError: true
        }
      }

      const created = await worktrees.create({ branch, base: stringOrNothing(input.base) })
      return {
        content:
          `Created worktree ${created.name} on ${created.branch} at ${created.path}. ` +
          'Start an agent there with `spawn_agent` and `worktree`.'
      }
    }
  }

  return [list, create]
}

/**
 * The worktree an agent meant: by branch, path, or directory name.
 *
 * A model that has just created a worktree will name it by the branch it asked
 * for, and one reading `list_worktrees` may copy the path instead.
 */
export function findWorktree(all: Worktree[], reference: string): Worktree | null {
  const wanted = reference.trim()
  const match = all.find(
    (worktree) => worktree.branch === wanted || worktree.path === wanted || worktree.name === wanted
  )
  if (!match) return null
  return match
}

/** One worktree, as the model reads it. */
function describeWorktree(worktree: Worktree, workspaceRoot: string): string {
  const parts = [worktree.branch, worktree.path]
  if (worktree.isMain) parts.push('main worktree')
  if (worktree.dirty) parts.push('uncommitted changes')
  if (worktree.path === workspaceRoot) parts.push('you are here')
  return `- ${parts.join(' · ')}`
}

/** Tool inputs arrive unvalidated; a value that is not a non-empty string is none. */
function stringOrNothing(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value.trim()
}
