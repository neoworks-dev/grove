// Supervised processes: list, start, stop and restart them per worktree.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as worktrees from '../worktrees'

export const servicesRoutes = {
  name: 'main/routes/services',
  inject: ['workbench', 'supervisor'],

  apply(ctx: Context): void {
    // ── Services ──────────────────────────────────────────────────
    route(ctx, 'services:list', (_e, worktreeId: string) => {
      const { config: cfg } = ctx.workbench.requireRepo()
      const worktree = ctx.workbench.findWorktree(worktreeId)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return Object.entries(cfg.services).map(([name, service]) => {
        const live = ctx.supervisor.getRuntime(worktreeId, name)
        return live || ctx.supervisor.buildIdleRuntime(worktree, name, service, ports)
      })
    })

    route(ctx, 'services:start', (_e, worktreeId: string, name: string) => {
      const { config: cfg } = ctx.workbench.requireRepo()
      const worktree = ctx.workbench.findWorktree(worktreeId)
      const service = cfg.services[name]
      if (!service) throw new Error(`unknown service: ${name}`)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return ctx.supervisor.start(worktree, name, service, ports)
    })

    route(ctx, 'services:startAll', async (_e, worktreeId: string) => {
      const { config: cfg } = ctx.workbench.requireRepo()
      const worktree = ctx.workbench.findWorktree(worktreeId)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      for (const [name, service] of Object.entries(cfg.services)) {
        await ctx.supervisor.start(worktree, name, service, ports)
      }
    })

    route(ctx, 'services:stop', (_e, worktreeId: string, name: string) =>
      ctx.supervisor.stop(worktreeId, name)
    )

    route(ctx, 'services:stopAll', (_e, worktreeId: string) =>
      ctx.supervisor.stopAllForWorktree(worktreeId)
    )

    route(ctx, 'services:restart', (_e, worktreeId: string, name: string) => {
      const { config: cfg } = ctx.workbench.requireRepo()
      const worktree = ctx.workbench.findWorktree(worktreeId)
      const service = cfg.services[name]
      if (!service) throw new Error(`unknown service: ${name}`)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return ctx.supervisor.start(worktree, name, service, ports)
    })
  }
}
