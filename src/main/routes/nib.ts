// The embedded agent server.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { registerNibProtocol } from '../nib/protocol'

export const nibRoutes = {
  name: 'main/routes/nib',
  inject: ['nib'],

  apply(ctx: Context): void {
    // ── Agent server ──────────────────────────────────────────────
    ctx.effect(() => registerNibProtocol(ctx.nib), 'protocol:grove-nib')
    route(ctx, 'nib:status', () => ctx.nib.status())
    route(ctx, 'nib:start', async () => {
      await ctx.nib.start()
      return ctx.nib.status()
    })
  }
}
