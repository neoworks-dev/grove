// The browser preview: the pane handing its page over, and pointing at an element in it.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'

export const browserRoutes = {
  name: 'main/routes/browser',
  inject: ['browser'],

  apply(ctx: Context): void {
    route(ctx, 'browser:attach', (_e, worktreeId: string, contentsId: number) =>
      ctx.browser.attach(worktreeId, contentsId)
    )
    route(ctx, 'browser:detach', (_e, worktreeId: string, contentsId: number) =>
      ctx.browser.detach(worktreeId, contentsId)
    )
    route(ctx, 'browser:pick', (_e, worktreeId: string) => ctx.browser.pick(worktreeId))
    route(ctx, 'browser:cancelPick', (_e, worktreeId: string) => ctx.browser.cancelPick(worktreeId))
    ctx.effect(() => ctx.browser.watchNewPages(), 'browser:watch-pages')
    ctx.effect(() => () => ctx.browser.dispose(), 'browser:dispose')
  }
}
