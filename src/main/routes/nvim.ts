// Embedded Neovim sidecars: one vendored `nvim --embed` per pane.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as worktrees from '../worktrees'
import { buildWorktreeEnv, spawnEnv } from '../env'

export const nvimRoutes = {
  name: 'main/routes/nvim',
  inject: ['workbench', 'nvim'],

  apply(ctx: Context): void {
    // ── Embedded Neovim ───────────────────────────────────────────
    // A vendored `nvim --embed` per pane, spawned in the worktree with the same
    // WT_*/PORT_n vars as ctx.terminals. Redraw batches stream via event:nvim-redraw.
    route(ctx, 'nvim:spawn', async (_e, worktreeId: string | null) => {
      let cwd = ctx.workbench.repoPath ?? process.cwd()
      let vars: Record<string, string> = {}
      if (worktreeId) {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        const cfg = ctx.workbench.requireRepo().config
        vars = buildWorktreeEnv(worktree, worktrees.portsForWorktree(cfg, worktree.portSlot))
        cwd = worktree.path
      }
      const sessionId = await ctx.nvim.manager.spawn({ cwd, env: spawnEnv(vars) })
      ctx.nvim.bind(sessionId, worktreeId)
      return sessionId
    })
    route(ctx, 'nvim:attach', (_e, id: string, cols: number, rows: number, file?: string) =>
      ctx.nvim.manager.attach(id, cols, rows, file)
    )
    route(ctx, 'nvim:input', (_e, id: string, keys: string) => {
      ctx.nvim.trackActivity(id)
      ctx.nvim.manager.input(id, keys)
    })
    route(
      ctx,
      'nvim:inputMouse',
      (
        _e,
        id: string,
        button: string,
        action: string,
        modifier: string,
        row: number,
        col: number,
        grid?: number
      ) => {
        ctx.nvim.trackActivity(id)
        ctx.nvim.manager.inputMouse(id, button, action, modifier, row, col, grid)
      }
    )
    route(ctx, 'nvim:resize', (_e, id: string, cols: number, rows: number) =>
      ctx.nvim.manager.resize(id, cols, rows)
    )
    route(ctx, 'nvim:command', (_e, id: string, command: string) =>
      ctx.nvim.manager.command(id, command)
    )
    route(ctx, 'nvim:request', (_e, id: string, method: string, args: unknown[]) =>
      ctx.nvim.manager.request(id, method, args)
    )
    route(ctx, 'nvim:kill', (_e, id: string) => ctx.nvim.manager.kill(id))
  }
}
