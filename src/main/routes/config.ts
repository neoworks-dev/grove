// The repository's workbench.yaml: read it and seed it.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as config from '../config'

export const configRoutes = {
  name: 'main/routes/config',
  inject: ['workbench'],

  apply(ctx: Context): void {
    // ── Config ────────────────────────────────────────────────────
    route(ctx, 'config:load', () => ctx.workbench.reloadConfig())

    route(ctx, 'config:exists', () => {
      const { repoPath } = ctx.workbench.requireRepo()
      return config.configExists(repoPath)
    })

    route(ctx, 'config:writeSample', async () => {
      const { repoPath } = ctx.workbench.requireRepo()
      const written = await config.writeSampleConfig(repoPath)
      await ctx.workbench.reloadConfig()
      return written
    })
  }
}
