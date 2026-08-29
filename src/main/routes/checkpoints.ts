// Local-only checkpoints: snapshot and restore a worktree.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'

export const checkpointsRoutes = {
  name: 'main/routes/checkpoints',
  inject: ['workbench', 'checkpoints'],

  apply(ctx: Context): void {
    // ── Local-only checkpoints ──────────────────────────────────────
    route(ctx, 'checkpoints:list', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return ctx.checkpoints.list(worktree.path)
    })

    route(ctx, 'checkpoints:snapshot', (_e, worktreeId: string, note?: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return ctx.checkpoints.snapshot(worktree.path, 'manual', { note })
    })

    route(ctx, 'checkpoints:restore', (_e, worktreeId: string, commit: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return ctx.checkpoints.restore(worktree.path, commit)
    })
  }
}
