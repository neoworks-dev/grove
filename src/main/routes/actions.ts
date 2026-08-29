// Keybind actions: shell commands run in a worktree from a binding.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import type { IpcMainInvokeEvent } from 'electron'
import * as worktrees from '../worktrees'

export const actionsRoutes = {
  name: 'main/routes/actions',
  inject: ['workbench', 'actions'],

  apply(ctx: Context): void {
    // ── Keybind actions ───────────────────────────────────────────
    route(
      ctx,
      'actions:runShell',
      (_e: IpcMainInvokeEvent, worktreeId: string, commandLine: string) => {
        const { config: cfg } = ctx.workbench.requireRepo()
        const worktree = ctx.workbench.findWorktree(worktreeId)
        const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
        ctx.actions.run(worktree, commandLine, ports)
      }
    )
  }
}
