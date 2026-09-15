// Provider credentials.
//
// The renderer may say what a credential is, and ask whether one exists. It may
// never read one back: nothing in the UI needs the value, and a key that never
// crosses the bridge cannot leak through a pane, a plugin or a screenshot.

import type { Context } from '@neoworks/extension-system'
import type { IpcMainInvokeEvent } from 'electron'
import { route } from '../kernel/route'

export const secretsRoutes = {
  name: 'main/routes/secrets',
  inject: ['workbench', 'secrets'],

  apply(ctx: Context): void {
    route(ctx, 'secrets:status', async (_e: IpcMainInvokeEvent, names: string[]) => {
      await ctx.secrets.load()
      return ctx.secrets.status(names)
    })

    route(ctx, 'secrets:set', async (_e: IpcMainInvokeEvent, name: string, value: string) => {
      await ctx.secrets.set(name, value)
      // Routes were listed with the credential they were missing, so the
      // catalogs that said so have to be asked again.
      ctx.workbench.send('event:secrets-changed', { name })
    })

    route(ctx, 'secrets:clear', async (_e: IpcMainInvokeEvent, name: string) => {
      await ctx.secrets.clear(name)
      ctx.workbench.send('event:secrets-changed', { name })
    })
  }
}
