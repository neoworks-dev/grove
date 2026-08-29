// Per-repo persisted state, and which worktrees the file watcher follows.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { getRepoState, updateRepoState } from '../state'

export const stateRoutes = {
  name: 'main/routes/state',
  inject: ['workbench', 'watcher'],

  apply(ctx: Context): void {
    // ── State ─────────────────────────────────────────────────────
    route(ctx, 'state:getRepo', () => {
      const { repoPath } = ctx.workbench.requireRepo()
      return getRepoState(repoPath)
    })

    route(ctx, 'state:update', (_e, patch: Record<string, unknown>) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return updateRepoState(repoPath, patch)
    })

    // ── File watching ─────────────────────────────────────────────
    // Watch exactly the given worktrees (selected + those with running agents).
    route(ctx, 'fs:watch', (_e, worktreeIds: string[]) => {
      const paths = worktreeIds
        .map((id) => ctx.workbench.worktrees.find((worktree) => worktree.id === id)?.path)
        .filter((path): path is string => Boolean(path))
      ctx.watcher.setWatched(paths)
    })
  }
}
