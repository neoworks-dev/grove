// Shell terminals, spawned with the worktree environment services see.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as worktrees from '../worktrees'
import { buildWorktreeEnv, spawnEnv } from '../env'

export const terminalsRoutes = {
  name: 'main/routes/terminals',
  inject: ['workbench', 'terminals', 'apps'],

  apply(ctx: Context): void {
    // ── Terminal ──────────────────────────────────────────────────
    // Spawn a shell in the worktree's directory with its WT_*/PORT_n vars, so a
    // terminal matches what services and keybind actions see.
    route(ctx, 'terminal:create', (_e, worktreeId: string | null, cols: number, rows: number) => {
      let cwd = ctx.workbench.repoPath ?? process.cwd()
      let vars: Record<string, string> = {}
      if (worktreeId) {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        const cfg = ctx.workbench.requireRepo().config
        vars = buildWorktreeEnv(worktree, worktrees.portsForWorktree(cfg, worktree.portSlot))
        cwd = worktree.path
      }
      // Tools launched inside Grove terminals discover the local API socket
      // with zero config.
      const socketPath = ctx.apps.socketPath()
      if (socketPath) vars.GROVE_SOCK = socketPath
      return ctx.terminals.create({ cwd, env: spawnEnv(vars), cols, rows })
    })
    route(ctx, 'terminal:write', (_e, id: string, data: string) => ctx.terminals.write(id, data))
    route(ctx, 'terminal:resize', (_e, id: string, cols: number, rows: number) =>
      ctx.terminals.resize(id, cols, rows)
    )
    route(ctx, 'terminal:kill', (_e, id: string) => ctx.terminals.kill(id))
  }
}
