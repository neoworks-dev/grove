// Prompt blame: which agent prompt wrote a line, or a commit's lines.

import type { Context } from '@neoworks/extension-system'
import { relative } from 'node:path'
import { route } from '../kernel/route'

export const blameRoutes = {
  name: 'main/routes/blame',
  inject: ['promptBlame', 'workbench'],

  apply(ctx: Context): void {
    // `path` may be absolute (a buffer name) or relative to the worktree.
    route(
      ctx,
      'blame:line',
      (_e, worktreeId: string, path: string, line: number, text: string) => {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        let relPath = path
        if (path.startsWith('/')) relPath = relative(worktree.path, path)
        return ctx.promptBlame.blameLine(worktree.path, relPath, line, text)
      }
    )

    route(ctx, 'blame:commitPrompts', (_e, worktreeId: string, sha: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return ctx.promptBlame.commitPrompts(worktree.path, sha)
    })
  }
}
