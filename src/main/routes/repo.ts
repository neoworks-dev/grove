// Opening a repository: pick a directory, open it, remember the last one.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { dialog } from 'electron'
import { loadState } from '../state'

export const repoRoutes = {
  name: 'main/routes/repo',
  inject: ['workbench'],

  apply(ctx: Context): void {
    // ── Repo ──────────────────────────────────────────────────────
    route(ctx, 'repo:pick', async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (result.canceled || result.filePaths.length === 0) return null
      return ctx.workbench.openRepo(result.filePaths[0])
    })

    route(ctx, 'repo:open', (_e, repoPath: string) => ctx.workbench.openRepo(repoPath))

    route(ctx, 'repo:last', async () => {
      const state = await loadState()
      return state.lastRepoPath
    })
  }
}
