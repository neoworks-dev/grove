// An agent laying out worktrees: listing them and creating one per task.
//
// Starting an agent in one is `spawn_agent`'s business and is tested with it,
// in agentComms.

import { describe, expect, test } from 'bun:test'
import { worktreeTools, type AgentWorktrees } from '../src/main/agents/tools/worktreeTools'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import type { Worktree } from '../src/shared/types'

function worktree(branch: string, path: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: branch,
    name: branch,
    path,
    branch,
    isMain: false,
    isDetached: false,
    locked: false,
    dirty: false,
    portSlot: 0,
    ...overrides
  }
}

/** A worktree list the tools can grow, recording what they were asked to create. */
function testWorktrees(): {
  worktrees: AgentWorktrees
  created: { branch: string; base?: string }[]
} {
  const all = [worktree('main', '/repo', { isMain: true })]
  const created: { branch: string; base?: string }[] = []
  const worktrees: AgentWorktrees = {
    list: () => Promise.resolve([...all]),
    create: (options) => {
      created.push(options)
      const made = worktree(options.branch, `/repo/.worktrees/${options.branch}`)
      all.push(made)
      return Promise.resolve(made)
    }
  }
  return { worktrees, created }
}

function toolNamed(name: string, worktrees: AgentWorktrees): GroveTool {
  const tool = worktreeTools(worktrees).find((entry) => entry.name === name)
  if (!tool) throw new Error(`${name} is not offered`)
  return tool
}

function context(workspaceRoot: string): GroveToolContext {
  return { sessionId: 'a', workspaceRoot, surface: () => {}, show: () => {} }
}

describe('creating a worktree', () => {
  test('asks the user first', () => {
    const { worktrees } = testWorktrees()
    expect(toolNamed('create_worktree', worktrees).policy).toBe('ask')
  })

  test('creates the branch and says where it is', async () => {
    const { worktrees, created } = testWorktrees()

    const result = await toolNamed('create_worktree', worktrees).execute(
      { branch: '12-parser', base: 'main' },
      context('/repo')
    )

    expect(result.isError).toBeUndefined()
    expect(created).toEqual([{ branch: '12-parser', base: 'main' }])
    expect(result.content).toContain('/repo/.worktrees/12-parser')
  })

  test('leaves the base to grove when none is given', async () => {
    const { worktrees, created } = testWorktrees()

    await toolNamed('create_worktree', worktrees).execute({ branch: '12-parser' }, context('/repo'))

    expect(created).toEqual([{ branch: '12-parser', base: undefined }])
  })

  test('refuses a branch that already has a worktree', async () => {
    const { worktrees, created } = testWorktrees()
    const tool = toolNamed('create_worktree', worktrees)
    await tool.execute({ branch: '12-parser' }, context('/repo'))

    const result = await tool.execute({ branch: '12-parser' }, context('/repo'))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('/repo/.worktrees/12-parser')
    expect(created).toHaveLength(1)
  })

  test('refuses an empty branch name', async () => {
    const { worktrees, created } = testWorktrees()

    const result = await toolNamed('create_worktree', worktrees).execute(
      { branch: '  ' },
      context('/repo')
    )

    expect(result.isError).toBe(true)
    expect(created).toEqual([])
  })
})

describe('listing worktrees', () => {
  test("names each by branch and path, and marks the caller's own", async () => {
    const { worktrees } = testWorktrees()
    await toolNamed('create_worktree', worktrees).execute({ branch: '12-parser' }, context('/repo'))

    const result = await toolNamed('list_worktrees', worktrees).execute(
      {},
      context('/repo/.worktrees/12-parser')
    )

    const lines = result.content.split('\n')
    expect(lines[0]).toBe('- main · /repo · main worktree')
    expect(lines[1]).toBe('- 12-parser · /repo/.worktrees/12-parser · you are here')
  })
})
