// The shared per-worktree chat channel (agent to agent, agent to user).

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'

export const chatRoutes = {
  name: 'main/routes/chat',
  inject: ['workbench', 'chat'],

  apply(ctx: Context): void {
    // ── Shared worktree chat (agent↔agent + agent↔user) ─────────────
    route(ctx, 'chat:send', (_e, worktreeId: string, text: string) => {
      ctx.workbench.findWorktree(worktreeId)
      return ctx.chat.post(worktreeId, { kind: 'user', name: 'you' }, text)
    })

    route(ctx, 'chat:history', async (_e, worktreeId: string, since?: number) => {
      ctx.workbench.findWorktree(worktreeId)
      // Watching is started lazily: a worktree whose channel nobody has opened
      // does not need a file ctx.watcher.
      await ctx.chat.watchWorktree(worktreeId)
      return ctx.chat.list(worktreeId, since)
    })
  }
}
