// A worktree refresh that is still listing the old repository when a new one
// opens must not put the old repository's worktrees back (issue #404).

import { describe, expect, test } from 'bun:test'
import { refreshRepoWorktrees, type RepoContext } from '../src/main/repoContext'
import type { Worktree, WorkbenchConfig } from '../src/shared/types'

const config = {} as WorkbenchConfig

/** A worktree list whose only entry is the repository root itself. */
function rootWorktree(repoPath: string): Worktree[] {
  return [{ id: repoPath, path: repoPath } as Worktree]
}

describe('refreshRepoWorktrees', () => {
  test('a listing of the old repo that finishes last does not replace the new one', async () => {
    const context: RepoContext = { repoPath: '/old', config, worktrees: rootWorktree('/old') }
    let releaseOldListing: () => void = () => {}
    const oldListingHeld = new Promise<void>((resolve) => {
      releaseOldListing = resolve
    })

    // Lists /old slowly and every other repo at once.
    const listWorktrees = async (repoPath: string): Promise<Worktree[]> => {
      if (repoPath === '/old') await oldListingHeld
      return rootWorktree(repoPath)
    }

    const staleRefresh = refreshRepoWorktrees(context, listWorktrees)
    context.repoPath = '/new'
    await refreshRepoWorktrees(context, listWorktrees)
    releaseOldListing()
    const staleResult = await staleRefresh

    expect(context.worktrees.map((worktree) => worktree.id)).toEqual(['/new'])
    expect(staleResult.map((worktree) => worktree.id)).toEqual(['/new'])
  })

  test('throws when no repository is open', async () => {
    const context: RepoContext = { repoPath: null, config: null, worktrees: [] }
    await expect(refreshRepoWorktrees(context, async () => [])).rejects.toThrow(
      'no repository opened'
    )
  })
})
