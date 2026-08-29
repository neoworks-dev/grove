// Worktree lifecycle: list, create, remove.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as worktrees from '../worktrees'

export const worktreesRoutes = {
  name: 'main/routes/worktrees',
  inject: ['workbench', 'supervisor'],

  apply(ctx: Context): void {
    // ── Worktrees ─────────────────────────────────────────────────
    route(ctx, 'worktrees:list', () => ctx.workbench.refreshWorktrees())

    route(
      ctx,
      'worktrees:create',
      async (_e, options: { name: string; baseBranch: string; newBranch?: string }) => {
        const { repoPath, config: cfg } = ctx.workbench.requireRepo()
        const created = await worktrees.createWorktree(repoPath, cfg, options, (worktreeId, line) =>
          ctx.workbench.send('event:log', { worktreeId, source: 'service', name: 'setup', line })
        )
        await ctx.workbench.refreshWorktrees()
        return created
      }
    )

    route(ctx, 'worktrees:remove', async (_e, worktreeId: string, force: boolean) => {
      const { repoPath } = ctx.workbench.requireRepo()
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await ctx.supervisor.stopAllForWorktree(worktreeId)
      await worktrees.removeWorktree(repoPath, worktree.path, force)
      return ctx.workbench.refreshWorktrees()
    })
  }
}
