// Plugin trust, permissions and the worker transport into the API dispatcher.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import type { IpcMainInvokeEvent } from 'electron'
import { registerPluginProtocol } from '../plugins/protocol'
import type { PermissionDecision as PluginPermissionDecision } from '../api/broker'
import type { PluginPermission } from '../../shared/plugins'

export const pluginsRoutes = {
  name: 'main/routes/plugins',
  inject: ['workbench', 'plugins', 'apps'],

  apply(ctx: Context): void {
    // ── Plugins ───────────────────────────────────────────────────
    ctx.effect(() => registerPluginProtocol(ctx.plugins.registry), 'protocol:grove-plugin')
    // Builtin and user plugins load before a repository is open; project
    // plugins join when one is.
    void ctx.plugins.registry.loadAll(null)
    route(ctx, 'plugins:list', () => ctx.plugins.list())
    route(ctx, 'plugins:trust', async (_e: IpcMainInvokeEvent, pluginId: string) => {
      const record = ctx.plugins.registry.get(pluginId)
      if (!record || !ctx.workbench.repoPath) return ctx.plugins.list()
      await ctx.plugins.broker.trustProjectPlugin(ctx.workbench.repoPath, record.manifest)
      await ctx.plugins.registry.refresh(pluginId)
      ctx.workbench.send('event:plugins-changed', ctx.plugins.list())
      return ctx.plugins.list()
    })
    route(
      ctx,
      'plugins:setEnabled',
      async (_e: IpcMainInvokeEvent, pluginId: string, enabled: boolean) => {
        await ctx.plugins.broker.setEnabled(pluginId, enabled)
        await ctx.plugins.registry.refresh(pluginId)
        if (!enabled) {
          ctx.plugins.aiBridge.clearPlugin(pluginId)
          ctx.plugins.dispatcher.cancelAllForClient(`plugin:${pluginId}`)
        }
        ctx.workbench.send('event:plugins-changed', ctx.plugins.list())
        return ctx.plugins.list()
      }
    )
    route(
      ctx,
      'plugins:invoke',
      (
        _e: IpcMainInvokeEvent,
        pluginId: string,
        callId: string,
        method: string,
        params: unknown
      ) => {
        const client = ctx.plugins.client(pluginId)
        const emit = (chunk: unknown): void =>
          ctx.workbench.send('event:plugin-stream', { pluginId, callId, chunk })
        const invoke = (): Promise<unknown> =>
          ctx.plugins.dispatcher.invoke(client, callId, method, params, {
            transport: 'worker',
            emit
          })
        if (!ctx.plugins.apiRoutes.get(method)?.streaming) return invoke()
        // Streaming wire contract: the invoke promise resolves immediately and
        // completion/errors travel as an end event, matching what the renderer
        // host awaits (mainStreams finish).
        void invoke()
          .then(() => ctx.workbench.send('event:plugin-stream', { pluginId, callId, end: true }))
          .catch((error: Error) =>
            ctx.workbench.send('event:plugin-stream', {
              pluginId,
              callId,
              end: true,
              error: { message: error.message }
            })
          )
        return null
      }
    )
    route(ctx, 'plugins:cancel', (_e: IpcMainInvokeEvent, pluginId: string, callId: string) =>
      ctx.plugins.dispatcher.cancel(`plugin:${pluginId}`, callId)
    )
    route(ctx, 'plugins:cancelAll', (_e: IpcMainInvokeEvent, pluginId: string) => {
      ctx.plugins.aiBridge.clearPlugin(pluginId)
      ctx.plugins.dispatcher.cancelAllForClient(`plugin:${pluginId}`)
    })
    route(
      ctx,
      'plugins:respondPermission',
      (_e: IpcMainInvokeEvent, id: string, decision: PluginPermissionDecision) =>
        ctx.plugins.broker.respondPermission(id, decision)
    )
    route(ctx, 'plugins:grants:list', async () =>
      ctx.plugins.broker.listGrants(await ctx.plugins.grantClients())
    )
    route(
      ctx,
      'plugins:grants:revoke',
      async (_e: IpcMainInvokeEvent, clientId: string, permission: PluginPermission) => {
        await ctx.plugins.broker.revoke(clientId, permission)
        return ctx.plugins.broker.listGrants(await ctx.plugins.grantClients())
      }
    )
    route(
      ctx,
      'plugins:grants:revokeScope',
      async (_e: IpcMainInvokeEvent, clientId: string, path: string) => {
        await ctx.plugins.broker.revokeFsScope(clientId, path)
        return ctx.plugins.broker.listGrants(await ctx.plugins.grantClients())
      }
    )
    route(ctx, 'plugins:grants:revokeAll', async (_e: IpcMainInvokeEvent, clientId: string) => {
      await ctx.plugins.broker.revokeAll(clientId)
      // Revoking everything for an external app also unpairs it.
      if (clientId.startsWith('app:')) {
        const appId = clientId.slice('app:'.length)
        await ctx.apps.pairing.revoke(appId)
        ctx.apps.dropClient(clientId)
      }
      return ctx.plugins.broker.listGrants(await ctx.plugins.grantClients())
    })

    // ── External apps ─────────────────────────────────────────────
    route(ctx, 'apps:list', () => ctx.apps.pairing.list())
    route(ctx, 'apps:respondPairing', (_e: IpcMainInvokeEvent, id: string, approved: boolean) =>
      ctx.apps.pairing.respondPairing(id, approved)
    )
    route(ctx, 'apps:revoke', async (_e: IpcMainInvokeEvent, appId: string) => {
      await ctx.apps.pairing.revoke(appId)
      await ctx.plugins.broker.revokeAll(`app:${appId}`)
      ctx.apps.dropClient(`app:${appId}`)
      return ctx.apps.pairing.list()
    })
    route(
      ctx,
      'plugins:respondToolCall',
      (_e: IpcMainInvokeEvent, id: string, result: unknown, errorMessage?: string) =>
        ctx.plugins.aiBridge.respondToolCall(id, result, errorMessage)
    )
  }
}
