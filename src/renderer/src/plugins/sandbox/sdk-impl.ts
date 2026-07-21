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
  function registerAndTrack<T>(
    map: Map<string, T>,
    key: string,
    value: T,
    method: string
  ): Disposable {
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
        return toDisposable(
          () => void rpc.request('host.registerKeybinding:dispose', { id: binding.id })
        )
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
          return toDisposable(
            () => void rpc.request('host.addStatusBarItem:dispose', { id: item.id })
          )
        },
        update(id, patch) {
          void rpc.request('host.updateStatusBarItem', { id, patch })
        }
      },
      sidebar: {
        addItem(item) {
          void rpc.request('host.addSidebarItem', item)
          return toDisposable(
            () => void rpc.request('host.addSidebarItem:dispose', { id: item.id })
          )
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
        rpc.request('host.getCurrentWorktree', {}) as ReturnType<
          GroveApi['workspace']['getCurrentWorktree']
        >,
      findFiles: (options) =>
        rpc.request('main.workspace.findFiles', options ?? {}) as Promise<string[]>,
      searchText(query, options) {
        return streamIterable(
          rpc,
          'main.workspace.searchText',
          {
            query,
            worktreeId: options?.worktreeId
          },
          options?.token
        )
      },
      readFile: (path, options) =>
        rpc.request('main.workspace.readFile', { path, ...options }) as Promise<string>,
      readExcerpt: (path, startLine, endLine, options) =>
        rpc.request('main.workspace.readExcerpt', {
          path,
          startLine,
          endLine,
          ...options
        }) as Promise<{ n: number; text: string }[]>,
      writeFile: (path, content, options) =>
        rpc.request('main.workspace.writeFile', { path, content, ...options }) as Promise<void>,
      openFile: (path, options) =>
        rpc.request('host.openFile', { path, ...options }) as Promise<void>,
      getActiveFile: () =>
        rpc.request('host.getActiveFile', {}) as ReturnType<
          GroveApi['workspace']['getActiveFile']
        >
    },

    ai: {
      prompt(request, token) {
        return streamIterable(rpc, 'main.ai.prompt', request, token) as ReturnType<
          GroveApi['ai']['prompt']
        >
      },
      registerSkill(skill) {
        void rpc.request('host.registerSkill', skill)
        return toDisposable(
          () => void rpc.request('host.registerSkill:dispose', { id: skill.name })
        )
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

    editor: {
      listEditors: () =>
        rpc.request('main.editor.listEditors', {}) as ReturnType<GroveApi['editor']['listEditors']>,
      getActiveEditor: () =>
        rpc.request('main.editor.getActiveEditor', {}) as ReturnType<
          GroveApi['editor']['getActiveEditor']
        >,
      openDocument: (path, options) =>
        rpc.request('main.editor.openDocument', { path, ...options }) as ReturnType<
          GroveApi['editor']['openDocument']
        >,
      readDocument: (path, options) =>
        rpc.request('main.editor.readDocument', { path, ...options }) as ReturnType<
          GroveApi['editor']['readDocument']
        >,
      getSelections: (path, options) =>
        rpc.request('main.editor.getSelections', { path, ...options }) as ReturnType<
          GroveApi['editor']['getSelections']
        >,
      applyEdit: (edit) =>
        rpc.request('main.editor.applyEdit', edit) as ReturnType<GroveApi['editor']['applyEdit']>,
      save: (path, options) =>
        rpc.request('main.editor.save', { path, ...options }) as ReturnType<
          GroveApi['editor']['save']
        >,
      setSelections: (path, selections, options) =>
        rpc.request('main.editor.setSelections', { path, selections, ...options }) as ReturnType<
          GroveApi['editor']['setSelections']
        >,
      setDecorations: (key, path, decorations, options) =>
        rpc.request('main.editor.setDecorations', {
          key,
          path,
          decorations,
          ...options
        }) as Promise<void>,
      show: (path, options) =>
        rpc.request('main.editor.show', { path, ...options }) as Promise<void>
    },

    git: {
      status: (options) =>
        rpc.request('main.git.status', options ?? {}) as ReturnType<GroveApi['git']['status']>,
      branches: (options) =>
        rpc.request('main.git.branches', options ?? {}) as ReturnType<GroveApi['git']['branches']>,
      diffFile: (path, options) =>
        rpc.request('main.git.diffFile', { path, ...options }) as ReturnType<
          GroveApi['git']['diffFile']
        >,
      fileAtRef: (path, ref, options) =>
        rpc.request('main.git.fileAtRef', { path, ref, ...options }) as Promise<string>,
      stage: (paths, options) =>
        rpc.request('main.git.stage', { paths, ...options }) as ReturnType<GroveApi['git']['stage']>,
      unstage: (paths, options) =>
        rpc.request('main.git.unstage', { paths, ...options }) as ReturnType<
          GroveApi['git']['unstage']
        >,
      commit: (message, options) =>
        rpc.request('main.git.commit', { message, ...options }) as ReturnType<
          GroveApi['git']['commit']
        >,
      push: (options) =>
        rpc.request('main.git.push', options ?? {}) as ReturnType<GroveApi['git']['push']>,
      worktrees: {
        list: () =>
          rpc.request('main.git.worktrees.list', {}) as ReturnType<
            GroveApi['git']['worktrees']['list']
          >,
        create: (options) =>
          rpc.request('main.git.worktrees.create', options) as ReturnType<
            GroveApi['git']['worktrees']['create']
          >,
        remove: (worktreeId) =>
          rpc.request('main.git.worktrees.remove', { worktreeId }) as Promise<void>,
        archive: (worktreeId) =>
          rpc.request('main.git.worktrees.archive', { worktreeId }) as Promise<void>
      },
      checkpoints: {
        list: (options) =>
          rpc.request('main.git.checkpoints.list', options ?? {}) as ReturnType<
            GroveApi['git']['checkpoints']['list']
          >,
        snapshot: (options) =>
          rpc.request('main.git.checkpoints.snapshot', options ?? {}) as ReturnType<
            GroveApi['git']['checkpoints']['snapshot']
          >,
        restore: (checkpointId, options) =>
          rpc.request('main.git.checkpoints.restore', { checkpointId, ...options }) as Promise<void>
      }
    },

    agents: {
      listChats: (options) =>
        rpc.request('main.agents.listChats', options ?? {}) as ReturnType<
          GroveApi['agents']['listChats']
        >,
      listModels: () =>
        rpc.request('main.agents.listModels', {}) as ReturnType<GroveApi['agents']['listModels']>,
      readTranscript: (chatId) =>
        rpc.request('main.agents.readTranscript', { chatId }) as ReturnType<
          GroveApi['agents']['readTranscript']
        >,
      isRunning: (chatId) =>
        rpc.request('main.agents.isRunning', { chatId }) as Promise<boolean>,
      observe(chatId, token) {
        return streamIterable(rpc, 'main.agents.observe', { chatId }, token) as ReturnType<
          GroveApi['agents']['observe']
        >
      },
      channelHistory: (options) =>
        rpc.request('main.agents.channelHistory', options ?? {}) as ReturnType<
          GroveApi['agents']['channelHistory']
        >,
      createChat: (options) =>
        rpc.request('main.agents.createChat', options ?? {}) as ReturnType<
          GroveApi['agents']['createChat']
        >,
      send: (chatId, message) =>
        rpc.request('main.agents.send', { chatId, message }) as Promise<void>,
      stop: (chatId) => rpc.request('main.agents.stop', { chatId }) as Promise<void>,
      cancelQueued: (chatId, queueId) =>
        rpc.request('main.agents.cancelQueued', { chatId, queueId }) as Promise<void>,
      sendChannelMessage: (text, options) =>
        rpc.request('main.agents.sendChannelMessage', { text, ...options }) as Promise<void>
    },

    terminals: {
      create: (options) =>
        rpc.request('main.terminals.create', options ?? {}) as ReturnType<
          GroveApi['terminals']['create']
        >,
      write: (terminalId, data) =>
        rpc.request('main.terminals.write', { terminalId, data }) as Promise<void>,
      resize: (terminalId, cols, rows) =>
        rpc.request('main.terminals.resize', { terminalId, cols, rows }) as Promise<void>,
      kill: (terminalId) => rpc.request('main.terminals.kill', { terminalId }) as Promise<void>,
      read(terminalId, token) {
        return streamIterable(rpc, 'main.terminals.read', { terminalId }, token) as ReturnType<
          GroveApi['terminals']['read']
        >
      }
    },

    languages: {
      hover: (path, position, options) =>
        rpc.request('main.languages.hover', { path, position, ...options }) as ReturnType<
          GroveApi['languages']['hover']
        >,
      definition: (path, position, options) =>
        rpc.request('main.languages.definition', { path, position, ...options }) as ReturnType<
          GroveApi['languages']['definition']
        >,
      references: (path, position, options) =>
        rpc.request('main.languages.references', { path, position, ...options }) as ReturnType<
          GroveApi['languages']['references']
        >,
      implementation: (path, position, options) =>
        rpc.request('main.languages.implementation', { path, position, ...options }) as ReturnType<
          GroveApi['languages']['implementation']
        >,
      typeDefinition: (path, position, options) =>
        rpc.request('main.languages.typeDefinition', { path, position, ...options }) as ReturnType<
          GroveApi['languages']['typeDefinition']
        >,
      completion: (path, position, options) =>
        rpc.request('main.languages.completion', { path, position, ...options }) as ReturnType<
          GroveApi['languages']['completion']
        >,
      inlayHints: (path, range, options) =>
        rpc.request('main.languages.inlayHints', { path, range, ...options }) as ReturnType<
          GroveApi['languages']['inlayHints']
        >,
      codeActions: (path, range, options) =>
        rpc.request('main.languages.codeActions', { path, range, ...options }) as ReturnType<
          GroveApi['languages']['codeActions']
        >,
      rename: (path, position, newName, options) =>
        rpc.request('main.languages.rename', {
          path,
          position,
          newName,
          ...options
        }) as ReturnType<GroveApi['languages']['rename']>,
      format: (path, options) =>
        rpc.request('main.languages.format', { path, ...options }) as ReturnType<
          GroveApi['languages']['format']
        >,
      applyCodeAction: (actionId, options) =>
        rpc.request('main.languages.applyCodeAction', { actionId, ...options }) as ReturnType<
          GroveApi['languages']['applyCodeAction']
        >
    },

    services: {
      list: (options) =>
        rpc.request('main.services.list', options ?? {}) as ReturnType<
          GroveApi['services']['list']
        >,
      readLogs(serviceId, options, token) {
        return streamIterable(
          rpc,
          'main.services.readLogs',
          { serviceId, ...options },
          token
        ) as ReturnType<GroveApi['services']['readLogs']>
      },
      start: (serviceId) => rpc.request('main.services.start', { serviceId }) as Promise<void>,
      stop: (serviceId) => rpc.request('main.services.stop', { serviceId }) as Promise<void>
    },

    settings: {
      get: <T>(key: string) =>
        rpc.request('host.getSetting', { key: `${pluginId}.${key}` }) as Promise<T | undefined>,
      set: (key, value, scope) =>
        rpc.request('host.setSetting', {
          key: `${pluginId}.${key}`,
          value,
          scope
        }) as Promise<void>,
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
      },
      subscribe(topics, token) {
        return streamIterable(rpc, 'main.events.subscribe', { topics }, token) as ReturnType<
          GroveApi['events']['subscribe']
        >
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
