// The repository's workbench.yaml: read it, seed it, detect services for it.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as config from '../config'
import { detectServices } from '../detect'
import type { ServiceConfig, WorkbenchConfig } from '../../shared/types'

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

    // Setup wizard: propose service entries from what the repo looks like.
    route(ctx, 'config:detect', () => {
      const { repoPath } = ctx.workbench.requireRepo()
      return detectServices(repoPath)
    })

    // Setup wizard: write the reviewed services into workbench.yaml, merged over
    // whatever is already there so a partially configured repo is not clobbered.
    route(ctx, 'config:writeServices', async (_e, services: Record<string, ServiceConfig>) => {
      const { repoPath } = ctx.workbench.requireRepo()
      const current = await config.loadConfig(repoPath)
      const merged: WorkbenchConfig = {
        ...current,
        services: { ...current.services, ...services }
      }
      await config.saveConfig(repoPath, merged)
      return ctx.workbench.reloadConfig()
    })
  }
}
