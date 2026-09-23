// Worktree lifecycle: list, create, remove.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as worktrees from '../worktrees'
import * as git from '../git'
import type { BranchPosition, Worktree } from '../../shared/types'

/**
 * Every worktree's position against the configured base branch, keyed by
 * worktree id. The worktree that has the base checked out, and any whose base
 * does not resolve, are left out.
 */
async function branchPositions(
  worktreeList: Worktree[],
  base: string
): Promise<Record<string, BranchPosition>> {
  const positions: Record<string, BranchPosition> = {}
  for (const worktree of worktreeList) {
    if (worktree.branch === base) continue
    const position = await git.aheadBehind(worktree.path, base)
    if (position) positions[worktree.id] = { base, ...position }
  }
  return positions
}

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

    // How far each worktree's branch is from the base branch, for its row.
    route(ctx, 'worktrees:positions', async () => {
      const { config } = ctx.workbench.requireRepo()
      const worktreeList: Worktree[] = await ctx.workbench.refreshWorktrees()
      return branchPositions(worktreeList, config.workbench.default_base_branch)
    })

    route(ctx, 'worktrees:remove', async (_e, worktreeId: string, force: boolean) => {
      const { repoPath } = ctx.workbench.requireRepo()
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await ctx.supervisor.stopAllForWorktree(worktreeId)
      await worktrees.removeWorktree(repoPath, worktree.path, force)
      return ctx.workbench.refreshWorktrees()
    })
  }
}
