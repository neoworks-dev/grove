// Worker-side implementation of the Grove plugin API. Everything is a thin
// RPC facade onto the host; handlers the plugin registers (commands, overlay
// handlers, pane renderers, MCP tools) stay in this worker and are invoked by
// host→worker requests. No DOM, no Node — postMessage is the only capability.

import type {
  GroveApi,
  Disposable,
  CancellationToken,
  OverlayHandler,
  OverlayItem,
  SurfaceNode,
  McpToolSpec
} from '../../../../../sdk/src/api'
import { GROVE_API_VERSION } from '../../../../../sdk/src/protocol'
import type { RpcEndpoint, RpcToken } from '../rpc'

function toDisposable(dispose: () => void): Disposable {
  return { dispose }
}

function bridgeToken(token: RpcToken): CancellationToken {
  return {
    get isCancelled() {
      return token.isCancelled
    },
    onCancel(callback) {
      token.onCancel(callback)
      return toDisposable(() => {})
    }
  }
}

export function buildGroveApi(rpc: RpcEndpoint, pluginId: string): GroveApi {
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>()
  const overlayHandlers = new Map<string, OverlayHandler>()
  const paneRenderers = new Map<string, (token: CancellationToken) => Promise<SurfaceNode>>()
  const mcpTools = new Map<string, McpToolSpec>()
  const settingsSubscribers = new Map<string, Set<(value: unknown) => void>>()

  // ── Host→worker dispatch ──────────────────────────────────────
  rpc.handle('command:execute', async (params) => {
    const { id, args } = params as { id: string; args?: unknown[] }
    const handler = commandHandlers.get(id)
    if (!handler) throw new Error(`no handler for command "${id}"`)
    return handler(...(args ?? []))
  })

  rpc.handle('overlay:query', async (params, context) => {
    const { overlayId, query } = params as { overlayId: string; query: string }
    const handler = overlayHandlers.get(overlayId)
    if (!handler) return undefined
    await handler.onQuery(query, (items) => context.emit(items), bridgeToken(context.token))
    return undefined
  })

  rpc.handle('overlay:preview', async (params, context) => {
    const { overlayId, item } = params as { overlayId: string; item: OverlayItem }
    const handler = overlayHandlers.get(overlayId)
    if (!handler?.onPreview) return null
    return handler.onPreview(item, bridgeToken(context.token))
  })

  rpc.handle('overlay:accept', async (params) => {
    const { overlayId, items } = params as { overlayId: string; items: OverlayItem[] }
    await overlayHandlers.get(overlayId)?.onAccept(items)
    return undefined
  })

  rpc.handle('pane:render', async (params, context) => {
    const { paneId } = params as { paneId: string }
    const renderer = paneRenderers.get(paneId)
    if (!renderer) return { type: 'text', text: 'No renderer registered.' }
    return renderer(bridgeToken(context.token))
  })

  rpc.handle('mcp:invokeTool', async (params) => {
    const { tool, input } = params as { tool: string; input: unknown }
    const spec = mcpTools.get(tool)
    if (!spec) throw new Error(`no MCP tool "${tool}"`)
    return spec.handler(input)
  })

  rpc.onEvent('settings:changed', (payload) => {
    const { key, value } = payload as { key: string; value: unknown }
    const subscribers = settingsSubscribers.get(key)
    if (!subscribers) return
    for (const callback of subscribers) callback(value)
  })

  // ── The API object ────────────────────────────────────────────
  function registerAndTrack<T>(map: Map<string, T>, key: string, value: T, method: string): Disposable {
    map.set(key, value)
    void rpc.request(method, { id: key })
    return toDisposable(() => {
      map.delete(key)
      void rpc.request(`${method}:dispose`, { id: key })
    })
  }

  const api: GroveApi = {
    version: GROVE_API_VERSION,

    commands: {
      register(id, handler) {
        commandHandlers.set(id, handler)
        void rpc.request('host.registerCommand', { id })
        return toDisposable(() => {
          commandHandlers.delete(id)
          void rpc.request('host.registerCommand:dispose', { id })
        })
      },
      execute(id, ...args) {
        return rpc.request('host.executeCommand', { id, args })
      }
    },

    keybindings: {
      register(binding) {
        void rpc.request('host.registerKeybinding', binding)
        return toDisposable(() => void rpc.request('host.registerKeybinding:dispose', { id: binding.id }))
      }
    },

    ui: {
      overlays: {
        register(descriptor, handler) {
          overlayHandlers.set(descriptor.id, handler)
          void rpc.request('host.registerOverlay', descriptor)
          return toDisposable(() => {
            overlayHandlers.delete(descriptor.id)
            void rpc.request('host.registerOverlay:dispose', { id: descriptor.id })
          })
        },
        setHandler(id, handler) {
          overlayHandlers.set(id, handler)
          return toDisposable(() => overlayHandlers.delete(id))
        },
        open: (id) => rpc.request('host.openOverlay', { id }) as Promise<void>,
        close: (id) => rpc.request('host.closeOverlay', { id }) as Promise<void>
      },
      statusBar: {
        addItem(item) {
          void rpc.request('host.addStatusBarItem', item)
          return toDisposable(() => void rpc.request('host.addStatusBarItem:dispose', { id: item.id }))
        },
        update(id, patch) {
          void rpc.request('host.updateStatusBarItem', { id, patch })
        }
      },
      sidebar: {
        addItem(item) {
          void rpc.request('host.addSidebarItem', item)
          return toDisposable(() => void rpc.request('host.addSidebarItem:dispose', { id: item.id }))
        }
      },
      menu: {
        addItem(item) {
          void rpc.request('host.addMenuItem', item)
          return toDisposable(() => void rpc.request('host.addMenuItem:dispose', { id: item.id }))
        }
      },
      dialogs: {
        confirm: (options) => rpc.request('host.confirmDialog', options) as Promise<string>
      },
      notify(options) {
        void rpc.request('host.notify', options)
      }
    },

    panes: {
      registerPaneType(id, render) {
        return registerAndTrack(paneRenderers, id, render, 'host.registerPaneType')
      },
      update(id) {
        void rpc.request('host.updatePane', { id })
      }
    },

    views: {
      register(view) {
        void rpc.request('host.registerView', view)
        return toDisposable(() => void rpc.request('host.registerView:dispose', { id: view.id }))
      }
    },

    workspace: {
      getCurrentWorktree: () =>
        rpc.request('host.getCurrentWorktree', {}) as ReturnType<GroveApi['workspace']['getCurrentWorktree']>,
      findFiles: (options) =>
        rpc.request('main.workspace.findFiles', options ?? {}) as Promise<string[]>,
      searchText(query, options) {
        return streamIterable(rpc, 'main.workspace.searchText', {
          query,
          worktreeId: options?.worktreeId
        }, options?.token)
      },
      readFile: (path, options) =>
        rpc.request('main.workspace.readFile', { path, ...options }) as Promise<string>,
      readExcerpt: (path, startLine, endLine, options) =>
        rpc.request('main.workspace.readExcerpt', { path, startLine, endLine, ...options }) as Promise<
          { n: number; text: string }[]
        >,
      writeFile: (path, content, options) =>
        rpc.request('main.workspace.writeFile', { path, content, ...options }) as Promise<void>,
      openFile: (path, options) =>
        rpc.request('host.openFile', { path, ...options }) as Promise<void>
    },

    ai: {
      prompt(request, token) {
        return streamIterable(rpc, 'main.ai.prompt', request, token) as ReturnType<GroveApi['ai']['prompt']>
      },
      registerSkill(skill) {
        void rpc.request('host.registerSkill', skill)
        return toDisposable(() => void rpc.request('host.registerSkill:dispose', { id: skill.name }))
      },
      registerMcpServer(server) {
        for (const tool of server.tools) mcpTools.set(tool.name, tool)
        const declaration = {
          name: server.name,
          tools: server.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }))
        }
        void rpc.request('host.registerMcpServer', declaration)
        return toDisposable(() => {
          for (const tool of server.tools) mcpTools.delete(tool.name)
          void rpc.request('host.registerMcpServer:dispose', { id: server.name })
        })
      }
    },

    settings: {
      get: <T>(key: string) =>
        rpc.request('host.getSetting', { key: `${pluginId}.${key}` }) as Promise<T | undefined>,
      set: (key, value, scope) =>
        rpc.request('host.setSetting', { key: `${pluginId}.${key}`, value, scope }) as Promise<void>,
      onChange(key, callback) {
        const fullKey = `${pluginId}.${key}`
        const set = settingsSubscribers.get(fullKey) ?? new Set()
        set.add(callback)
        settingsSubscribers.set(fullKey, set)
        void rpc.request('host.watchSetting', { key: fullKey })
        return toDisposable(() => set.delete(callback))
      }
    },

    events: {
      on(event, callback) {
        const channel = `grove-event:${event}`
        rpc.onEvent(channel, callback)
        void rpc.request('host.subscribeEvent', { event })
        return toDisposable(() => rpc.onEvent(channel, () => {}))
      }
    }
  }

  return api
}

// Bridge a host/main streaming call into an AsyncIterable of items. Chunks may
// be arrays (batches) or single values.
function streamIterable<T>(
  rpc: RpcEndpoint,
  method: string,
  params: unknown,
  token?: CancellationToken
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const queue: T[] = []
      let finished = false
      let failure: Error | null = null
      let wake: (() => void) | null = null

      const notify = (): void => {
        wake?.()
        wake = null
      }
      const handle = rpc.requestStream(method, params, (chunk) => {
        if (Array.isArray(chunk)) queue.push(...(chunk as T[]))
        else queue.push(chunk as T)
        notify()
      })
      handle.done.then(
        () => {
          finished = true
          notify()
        },
        (error: Error) => {
          failure = error
          finished = true
          notify()
        }
      )
      token?.onCancel(() => handle.cancel())

      return {
        async next(): Promise<IteratorResult<T>> {
          while (queue.length === 0 && !finished) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
          if (queue.length > 0) return { value: queue.shift() as T, done: false }
          if (failure && failure.message !== 'cancelled') throw failure
          return { value: undefined as never, done: true }
        },
        async return(): Promise<IteratorResult<T>> {
          handle.cancel()
          finished = true
          return { value: undefined as never, done: true }
        }
      }
    }
  }
}
