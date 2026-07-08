// Plugin worker entry. Owns the RPC endpoint over postMessage, injects the
// Grove API as globalThis.__grove, then imports the plugin bundle and calls
// its activate(). This chunk is app code ('self' CSP); only the dynamic
// import() below crosses into grove-plugin:// territory.

import type { RpcMessage } from '../../../../shared/plugins'
import type { Disposable, GroveApi, PluginContext } from '../../../../../sdk/src/api'
import { RpcEndpoint } from '../rpc'
import { buildGroveApi } from './sdk-impl'

interface InitMessage {
  kind: 'init'
  pluginId: string
  entryUrl: string
  apiVersion: string
}

interface PluginModule {
  activate?: (context: PluginContext) => void | Promise<void>
  deactivate?: () => void | Promise<void>
}

let endpoint: RpcEndpoint | null = null
let pluginModule: PluginModule | null = null
const subscriptions: Disposable[] = []

async function start(init: InitMessage): Promise<void> {
  const rpc = new RpcEndpoint((message) => self.postMessage(message), 'odd')
  endpoint = rpc
  const api: GroveApi = buildGroveApi(rpc, init.pluginId)
  globalThis.__grove = api

  rpc.handle('lifecycle:deactivate', async () => {
    await pluginModule?.deactivate?.()
    for (const subscription of subscriptions) subscription.dispose()
    return undefined
  })

  const context: PluginContext = {
    pluginId: init.pluginId,
    subscriptions,
    storage: {
      get: <T>(key: string) =>
        rpc.request('main.storage.get', { key }) as Promise<T | undefined>,
      set: (key, value) => rpc.request('main.storage.set', { key, value }) as Promise<void>,
      delete: (key) => rpc.request('main.storage.delete', { key }) as Promise<void>
    }
  }

  pluginModule = (await import(/* @vite-ignore */ init.entryUrl)) as PluginModule
  await pluginModule.activate?.(context)
  self.postMessage({ kind: 'event', channel: 'lifecycle:ready', payload: null })
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as InitMessage | RpcMessage
  if ((data as InitMessage).kind === 'init') {
    void start(data as InitMessage).catch((error: Error) => {
      self.postMessage({
        kind: 'event',
        channel: 'lifecycle:error',
        payload: { message: error.message, stack: error.stack }
      })
    })
    return
  }
  endpoint?.handleMessage(data as RpcMessage)
}
