// Resolving merge conflicts with an agent: the prompt that asks for proposals,
// the proposals themselves, and writing back the ones the user settled.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { resolutionPrompt, writeResolutions } from '../conflictResolution'
import type { ConflictResolutionLines } from '../../shared/types'

export const conflictsRoutes = {
  name: 'main/routes/conflicts',
  inject: ['workbench', 'conflictProposals'],

  apply(ctx: Context): void {
    route(ctx, 'conflicts:agentPrompt', (_e, worktreeId: string, paths: string[] | null) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return resolutionPrompt(worktree.path, paths)
    })

    route(ctx, 'conflicts:proposals', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return ctx.conflictProposals.current(worktree.path)
    })

    route(ctx, 'conflicts:clearProposals', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      ctx.conflictProposals.clear(worktree.path)
    })

    route(
      ctx,
      'conflicts:write',
      async (_e, worktreeId: string, resolutions: ConflictResolutionLines[]) => {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        const staged = await writeResolutions(worktree.path, resolutions)
        ctx.conflictProposals.clear(worktree.path)
        return staged
      }
    )
  }
}
