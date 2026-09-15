// Endpoints the user brought themselves.

import type { Context } from '@neoworks/extension-system'
import type { IpcMainInvokeEvent } from 'electron'
import type { CustomEndpoint } from '../../shared/agents'
import { discoverModels } from '../endpoints'
import { route } from '../kernel/route'

export const endpointRoutes = {
  name: 'main/routes/endpoints',
  inject: ['workbench', 'endpoints', 'secrets'],

  apply(ctx: Context): void {
    route(ctx, 'endpoints:list', async () => {
      await ctx.endpoints.load()
      return ctx.endpoints.list()
    })

    route(ctx, 'endpoints:save', async (_e: IpcMainInvokeEvent, endpoint: CustomEndpoint) => {
      const saved = await ctx.endpoints.save(endpoint)
      ctx.workbench.send('event:endpoints-changed', saved)
      return saved
    })

    route(ctx, 'endpoints:remove', async (_e: IpcMainInvokeEvent, id: string) => {
      const remaining = await ctx.endpoints.remove(id)
      ctx.workbench.send('event:endpoints-changed', remaining)
      return remaining
    })

    // Asked before an endpoint is saved, so the dialog can say whether the URL
    // answers and what it serves rather than leaving that to the first turn.
    route(
      ctx,
      'endpoints:probe',
      async (_e: IpcMainInvokeEvent, baseUrl: string, keyVariable?: string) => {
        await ctx.secrets.load()
        const key = keyVariable ? ctx.secrets.get(keyVariable) : null
        const models = await discoverModels(baseUrl, key)
        return { models }
      }
    )
  }
}
