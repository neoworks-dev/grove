// The open repository as main tracks it, and the one way its worktree list is
// refreshed. Kept free of Electron so the refresh's ordering can be tested.
//
// Refreshes are not serialised: the renderer's focus and interval refreshes,
// GitHub routes and openRepo all run one whenever they like, and listing a repo
// takes long enough (`git status` per worktree) for the repo to be switched
// underneath one. A refresh only commits a list for the repo that is open when
// it finishes, so an old repo's list never replaces the new one's.

import type { Worktree, WorkbenchConfig } from '../shared/types'

export interface RepoContext {
  repoPath: string | null
  config: WorkbenchConfig | null
  worktrees: Worktree[]
}

/** Lists a repository's worktrees; `worktrees.listWithPorts` in the app. */
export type ListWorktrees = (repoPath: string, config: WorkbenchConfig) => Promise<Worktree[]>

/**
 * Re-lists the open repository's worktrees into the context and returns them.
 * When the open repository changes while a listing is in flight, that listing
 * is dropped and the now-open repository is listed instead.
 */
export async function refreshRepoWorktrees(
  context: RepoContext,
  listWorktrees: ListWorktrees
): Promise<Worktree[]> {
  for (;;) {
    if (!context.repoPath || !context.config) {
      throw new Error('no repository opened')
    }
    const repoPath = context.repoPath
    const worktrees = await listWorktrees(repoPath, context.config)
    if (context.repoPath === repoPath) {
      context.worktrees = worktrees
      return worktrees
    }
  }
}
