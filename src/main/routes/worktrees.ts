// Worktree lifecycle: list, create, remove.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as worktrees from '../worktrees'
import * as git from '../git'
import type {
  BranchPosition,
  WorkbenchConfig,
  Worktree,
  WorktreeSetupState
} from '../../shared/types'

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
    if (!position) continue
    let mergedLocally = false
    if (position.ahead === 0)
      mergedLocally = await git.branchHasMoved(worktree.path, worktree.branch)
    positions[worktree.id] = { base, ...position, mergedLocally }
  }
  return positions
}

// Setup that is running or failed, by worktree id. A worktree whose setup
// succeeded is dropped, so a reloaded renderer only hears what still matters.
const setupStates: Record<string, WorktreeSetupState> = {}

/** Records a worktree's setup state and tells the renderer. */
function reportSetup(ctx: Context, worktreeId: string, state: WorktreeSetupState): void {
  if (state === 'done') {
    delete setupStates[worktreeId]
  } else {
    setupStates[worktreeId] = state
  }
  ctx.workbench.send('event:worktree-setup', { worktreeId, state })
}

/** Runs a new worktree's setup, streaming its output to the worktree's logs. */
async function runSetup(
  ctx: Context,
  repoPath: string,
  config: WorkbenchConfig,
  worktree: Worktree
): Promise<void> {
  reportSetup(ctx, worktree.id, 'running')
  let succeeded = false
  try {
    succeeded = await worktrees.setupWorktree(repoPath, config, worktree, (worktreeId, line) =>
      ctx.workbench.send('event:log', { worktreeId, source: 'service', name: 'setup', line })
    )
  } catch (error) {
    ctx.workbench.send('event:log', {
      worktreeId: worktree.id,
      source: 'service',
      name: 'setup',
      line: `[setup] ${(error as Error).message}`
    })
  }
  if (succeeded) {
    reportSetup(ctx, worktree.id, 'done')
  } else {
    reportSetup(ctx, worktree.id, 'failed')
  }
}

export const worktreesRoutes = {
  name: 'main/routes/worktrees',
  inject: ['workbench', 'supervisor'],

  apply(ctx: Context): void {
    // ── Worktrees ─────────────────────────────────────────────────
    route(ctx, 'worktrees:list', () => ctx.workbench.refreshWorktrees())

    // Resolves as soon as the worktree is checked out; its setup commands run
    // after, reported through `event:worktree-setup`, so the worktree can be
    // selected and an agent briefed without waiting on them.
    route(
      ctx,
      'worktrees:create',
      async (_e, options: { name: string; baseBranch: string; newBranch?: string }) => {
        const { repoPath, config: cfg } = ctx.workbench.requireRepo()
        const created = await worktrees.addWorktree(repoPath, cfg, options)
        await ctx.workbench.refreshWorktrees()
        void runSetup(ctx, repoPath, cfg, created)
        return created
      }
    )

    route(ctx, 'worktrees:setupStates', () => ({ ...setupStates }))

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
