// Opening a repository: pick a directory, open it, remember the last one and
// the recent ones.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { platform } from '../platform'
import { loadState, clearRecentRepos } from '../state'

export const repoRoutes = {
  name: 'main/routes/repo',
  inject: ['workbench'],

  apply(ctx: Context): void {
    // ── Repo ──────────────────────────────────────────────────────
    route(ctx, 'repo:pick', async () => {
      const directory = await platform().pickDirectory()
      if (directory === null) return null
      return ctx.workbench.openRepo(directory)
    })

    route(ctx, 'repo:open', (_e, repoPath: string) => ctx.workbench.openRepo(repoPath))

    route(ctx, 'repo:last', async () => {
      const state = await loadState()
      return state.lastRepoPath
    })

    route(ctx, 'repo:recent', async () => {
      const state = await loadState()
      return state.recentRepoPaths
    })

    route(ctx, 'repo:clearRecent', async () => {
      await clearRecentRepos()
      ctx.workbench.send('event:recent-repos', [])
    })
  }
}
