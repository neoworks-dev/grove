// PluginHost: loads plugin records, mounts one kernel fiber per plugin, and
// manages the sandboxed Web Worker that fiber owns. All worker→host API calls
// land here; privileged ones forward to main over plugin-scoped IPC (pluginId
// stamped by this host, never by the worker).
//
// Every registration a plugin makes — manifest contribution, runtime call, the
// worker process itself — is installed through its fiber's `ctx.effect`, so
// unloading the plugin is `fiber.dispose()` and nothing can be left behind. The
// fiber injects the surfaces it contributes into, so a plugin also stops when
// the sidebar, editor or panel it targets goes away.

import type { Context, Fiber } from '@neoworks/extension-system'
import type { PluginManifest } from '../../../shared/plugins'
import { GROVE_API_VERSION, PERMISSION_META } from '../../../shared/plugins'
import { RpcEndpoint } from './rpc'
import { groveContext } from '../kernel/context'
import { overlays, type OverlayItem, type OverlayPreviewContent } from '../lib/overlays.svelte'
import { dialogs } from '../lib/dialogs.svelte'
import { settings } from '../lib/settings.svelte'
import { store, openFileInEditor, openFileAtLine } from '../lib/store.svelte'
import { sanitize, createLeaf } from '../lib/layoutTree'
import { isAbsolutePath, joinPath, relativePath } from '../lib/paths'
import { activeNvimSession } from '../lib/nvim/registry'
import type { SettingDefinition } from '../../../shared/settings'
import DeclarativeSurface from '../components/DeclarativeSurface.svelte'
import DeclarativeStatusItem from '../components/DeclarativeStatusItem.svelte'

export interface PluginRecordShape {
  id: string
  manifest: PluginManifest
  source: 'builtin' | 'user' | 'project'
  status: 'ready' | 'disabled' | 'blocked' | 'invalid'
  errors: string[]
}

interface HostStatusItem {
  text: string
  tooltip?: string
  command?: string
}

interface OverlayDeclaration {
  id: string
  title: string
  placeholder?: string
  preview?: boolean
  multiSelect?: boolean
  debounceMs?: number
}

interface MainStream {
  emit: (chunk: unknown) => void
  finish: (error?: Error) => void
}

interface PluginInstance {
  record: PluginRecordShape
  // The plugin's fiber and its context. Every effect this plugin installs
  // belongs to them, so disposing the fiber reverts all of it.
  fiber: Fiber | null
  ctx: Context | null
  worker: Worker | null
  rpc: RpcEndpoint | null
  activating: Promise<void> | null
  runtimeError: string | null
  // Effect disposers the plugin can revert individually through a `:dispose`
  // RPC call, keyed by registration. The fiber owns them too, so an unload
  // still cleans up whatever the plugin forgot.
  effects: Map<string, () => void>
  overlayDeclarations: Map<string, OverlayDeclaration>
  mainStreams: Map<string, MainStream>
  subscribedEvents: Set<string>
  watchedSettings: Set<string>
  // Skill/MCP declarations stashed for the AI bridge (wired in a later phase).
  mcpServers: Map<string, unknown>
  skills: Map<string, unknown>
}

/**
 * One fiber per plugin record. It injects the surfaces plugins contribute into,
 * so it only runs while they exist; its body hands the context back to the host,
 * which installs the plugin's contributions on it.
 */
class WorkerPlugin {
  static inject = [
    'commands',
    'keymap',
    'panes',
    'views',
    'statusbar',
    'menu',
    'sidebar',
    'panel',
    'settings',
    'dialogs',
    'overlays',
    'layout',
    'workspace',
    'editor'
  ]

  constructor(ctx: Context, config: { host: PluginHost; record: PluginRecordShape }) {
    config.host.attachFiber(config.record.id, ctx)
  }
}

class PluginHost {
  plugins = $state<PluginRecordShape[]>([])
  // Bumped when a plugin calls panes.update(id) so surfaces re-render.
  paneVersions = $state<Record<string, number>>({})
  statusItems = $state<Record<string, HostStatusItem>>({})

  private instances = new Map<string, PluginInstance>()
  // paneTypeId/commandId → owning plugin id.
  private paneOwners = new Map<string, string>()
  private commandOwners = new Map<string, string>()
  private overlayOwners = new Map<string, string>()
  private trustPrompted = new Set<string>()

  // ── Public accessors used by declarative components ──────────
  paneVersion(paneTypeId: string): number {
    return this.paneVersions[paneTypeId] ?? 0
  }

  statusItem(itemId: string): HostStatusItem | null {
    return this.statusItems[itemId] ?? null
  }

  async renderPane(paneTypeId: string): Promise<unknown> {
    const instance = this.owningInstance(this.paneOwners.get(paneTypeId))
    if (!instance) return { type: 'text', text: 'Plugin not available.' }
    await this.ensureActivated(instance.record.id)
    return instance.rpc?.request('pane:render', { paneId: paneTypeId })
  }

  async executeCommandById(commandId: string, args: unknown[]): Promise<unknown> {
    const ownerId = this.commandOwners.get(commandId)
    if (ownerId) {
      await this.ensureActivated(ownerId)
      const instance = this.instances.get(ownerId)
      return instance?.rpc?.request('command:execute', { id: commandId, args })
    }
    const command = groveContext.commands.commands.find((entry) => entry.id === commandId)
    if (command) return command.run()
    dialogs.notify({ level: 'error', message: `Unknown command "${commandId}"` })
    return undefined
  }

  // ── Lifecycle ─────────────────────────────────────────────────
  async init(): Promise<void> {
    window.workbench.on('event:plugin-stream', (payload) => this.onMainStream(payload))
    window.workbench.on('event:plugin-tool-call', (payload) => void this.onPluginToolCall(payload))
    window.workbench.on('event:plugin-permission', (payload) => void this.onPermissionRequest(payload))
    window.workbench.on('event:app-pairing', (payload) => void this.onAppPairingRequest(payload))
    window.workbench.on('event:api-open-file', (payload) => this.onApiOpenFile(payload))
    // Visibility mitigation for terminal.exec: the user always learns when an
    // API client opens a terminal.
    window.workbench.on('event:api-terminal-created', (payload) => {
      const { clientName } = payload as { clientName: string }
      dialogs.notify({ level: 'info', message: `${clientName} opened a terminal` })
    })
    window.workbench.on('event:plugins-changed', (payload) =>
      this.applyRecords(payload as PluginRecordShape[])
    )
    const records = await window.workbench.plugins.list()
    this.applyRecords(records as PluginRecordShape[])
  }

  private applyRecords(records: PluginRecordShape[]): void {
    this.plugins = records
    const known = new Set(records.map((record) => record.id))
    for (const [id, instance] of this.instances) {
      const record = records.find((entry) => entry.id === id)
      if (record && record.status === 'ready') continue
      void this.disposeInstance(instance)
      this.instances.delete(id)
      if (!known.has(id)) continue
    }
    for (const record of records) {
      if (record.status === 'ready' && !this.instances.has(record.id)) {
        this.registerInstance(record)
      }
      if (record.status === 'blocked') void this.promptTrust(record)
    }
  }

  private registerInstance(record: PluginRecordShape): void {
    const instance: PluginInstance = {
      record,
      fiber: null,
      ctx: null,
      worker: null,
      rpc: null,
      activating: null,
      runtimeError: null,
      effects: new Map(),
      overlayDeclarations: new Map(),
      mainStreams: new Map(),
      subscribedEvents: new Set(),
      watchedSettings: new Set(),
      mcpServers: new Map(),
      skills: new Map()
    }
    this.instances.set(record.id, instance)
    // The fiber calls back into attachFiber() once its injected services
    // resolve; until then the plugin contributes nothing, which is correct.
    instance.fiber = groveContext.plugin(WorkerPlugin, { host: this, record })
  }

  /**
   * Called from the plugin's fiber body. Installs the manifest contributions on
   * the fiber's context and starts the worker if the plugin activates on
   * startup. Runs again after a reload, so it must not assume a clean slate.
   */
  attachFiber(pluginId: string, ctx: Context): void {
    const instance = this.instances.get(pluginId)
    if (!instance) return
    // A reload reverted the previous generation's effects, worker included, so
    // the activation state has to start over with them.
    instance.ctx = ctx
    instance.effects.clear()
    instance.worker = null
    instance.rpc = null
    instance.activating = null
    this.contribute(instance)
    const activation = instance.record.manifest.activation ?? ['onStartup']
    if (activation.includes('onStartup')) void this.ensureActivated(pluginId)
  }

  private async disposeInstance(instance: PluginInstance): Promise<void> {
    instance.rpc?.failAllPending('plugin disposed')
    // Reverts every contribution, every runtime registration and the worker
    // itself — they are all effects on this fiber.
    await instance.fiber?.dispose()
    instance.fiber = null
    instance.ctx = null
    instance.effects.clear()
    instance.worker = null
    instance.rpc = null
    instance.activating = null
    void window.workbench.plugins.cancelAll(instance.record.id)
  }

  private async promptTrust(record: PluginRecordShape): Promise<void> {
    const key = `${record.id}@${record.manifest.version}`
    if (this.trustPrompted.has(key)) return
    this.trustPrompted.add(key)
    const permissions = (record.manifest.permissions ?? []).join(', ') || 'none'
    const choice = await dialogs.confirm({
      title: `Trust project plugin "${record.manifest.name}"?`,
      body:
        `This repository ships the plugin "${record.id}" v${record.manifest.version}. ` +
        'Project plugins run code from the repository.',
      detail: `requested permissions: ${permissions}`,
      actions: [
        { id: 'trust', label: 'Trust and enable', kind: 'primary' },
        { id: 'cancel', label: 'Not now' }
      ]
    })
    if (choice === 'trust') await window.workbench.plugins.trust(record.id)
  }

  private async onPermissionRequest(payload: unknown): Promise<void> {
    const request = payload as {
      id: string
      pluginName: string
      permission: string
      detail: string
    }
    const choice = await dialogs.confirm({
      title: `"${request.pluginName}" requests ${request.permission}`,
      body: 'Allow this plugin to use the capability?',
      detail: request.detail,
      actions: [
        { id: 'allow-always', label: 'Always allow', kind: 'primary' },
        { id: 'allow-once', label: 'Allow once' },
        { id: 'deny-always', label: 'Always deny', kind: 'danger' },
        { id: 'cancel', label: 'Deny' }
      ]
    })
    const decision = choice === 'cancel' ? 'deny-once' : choice
    await window.workbench.plugins.respondPermission(request.id, decision)
  }

  // External app pairing: an unpaired process on the local API socket asked
  // to connect. Approval mints a bearer token scoped to the listed
  // capabilities; the grants pane can review or unpair later.
  private async onAppPairingRequest(payload: unknown): Promise<void> {
    const request = payload as {
      id: string
      appId: string
      appName: string
      requestedScopes: string[]
    }
    const scopeLines = request.requestedScopes
      .map((scope) => {
        const meta = PERMISSION_META[scope as keyof typeof PERMISSION_META]
        if (!meta) return scope
        if (meta.risk === 'danger') return `${meta.label} (⚠ ${scope})`
        return `${meta.label} (${scope})`
      })
      .join(', ')
    const choice = await dialogs.confirm({
      title: `Pair external app "${request.appName}"?`,
      body:
        `A local process identifying as "${request.appId}" wants to connect to Grove. ` +
        'Only pair apps you started yourself.',
      detail: `requested access: ${scopeLines || 'none'}`,
      actions: [
        { id: 'approve', label: 'Pair', kind: 'primary' },
        { id: 'cancel', label: 'Deny' }
      ]
    })
    await window.workbench.apps.respondPairing(request.id, choice === 'approve')
  }

  // editor.show route: main asks the renderer to reveal a file.
  private onApiOpenFile(payload: unknown): void {
    const { worktreeId, path, line } = payload as {
      worktreeId: string
      path: string
      line?: number
    }
    const worktree = store.worktrees.find((entry) => entry.id === worktreeId)
    const absPath = isAbsolutePath(path) ? path : joinPath(worktree?.path ?? '', path)
    if (typeof line === 'number') openFileAtLine(worktreeId, absPath, line)
    else openFileInEditor(worktreeId, absPath)
  }

  // ── Activation ────────────────────────────────────────────────
  async ensureActivated(pluginId: string): Promise<void> {
    const instance = this.instances.get(pluginId)
    if (!instance) throw new Error(`plugin not loaded: ${pluginId}`)
    if (instance.rpc) return
    if (instance.activating) return instance.activating
    instance.activating = this.activate(instance)
    return instance.activating
  }

  // The worker is an effect on the plugin's fiber: spawning it registers its
  // own inverse, so an unload terminates it even mid-activation.
  private activate(instance: PluginInstance): Promise<void> {
    const ctx = instance.ctx
    if (!ctx) return Promise.reject(new Error(`plugin not mounted: ${instance.record.id}`))

    return new Promise((resolve, reject) => {
      ctx.effect(() => {
        const worker = new Worker(new URL('./sandbox/bootstrap.ts', import.meta.url), {
          type: 'module'
        })
        const rpc = new RpcEndpoint((message) => worker.postMessage(message), 'even')
        this.registerHostMethods(instance, rpc)
        instance.worker = worker
        instance.rpc = rpc

        rpc.onEvent('lifecycle:ready', () => resolve())
        rpc.onEvent('lifecycle:error', (payload) => {
          const message = (payload as { message?: string }).message ?? 'plugin crashed'
          this.crash(instance, message)
          reject(new Error(message))
        })
        worker.onmessage = (event) => rpc.handleMessage(event.data)
        worker.onerror = (event) => {
          this.crash(instance, event.message || 'worker error')
          reject(new Error(event.message || 'worker error'))
        }
        worker.postMessage({
          kind: 'init',
          pluginId: instance.record.id,
          entryUrl: `grove-plugin://${instance.record.id}/${instance.record.manifest.entry}`,
          apiVersion: GROVE_API_VERSION
        })

        return () => worker.terminate()
      }, `worker:${instance.record.id}`)
    })
  }

  private crash(instance: PluginInstance, message: string): void {
    instance.runtimeError = message
    dialogs.notify({ level: 'error', message: `Plugin ${instance.record.id}: ${message}` })
    void this.disposeInstance(instance)
  }

  async deactivate(pluginId: string): Promise<void> {
    const instance = this.instances.get(pluginId)
    if (!instance?.rpc) return
    await Promise.race([
      instance.rpc.request('lifecycle:deactivate', {}),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]).catch(() => {})
    await this.disposeInstance(instance)
  }

  // ── Manifest contributions (lazy stubs, registered before activation) ──
  // Each one is an effect on the plugin's fiber, so it is reverted by an unload
  // and by the disappearance of the service it was registered against.
  private contribute(instance: PluginInstance): void {
    const { manifest } = instance.record
    const contributes = manifest.contributes ?? {}
    const ctx = instance.ctx
    if (!ctx) return
    const pluginId = instance.record.id
    const add = (execute: () => () => void, label: string): void => {
      ctx.effect(execute, `${pluginId}:${label}`)
    }

    for (const command of contributes.commands ?? []) {
      add(() => {
        this.commandOwners.set(command.id, pluginId)
        const dispose = ctx.commands.register({
          id: command.id,
          title: command.title,
          group: command.group,
          keywords: command.keywords,
          run: () => void this.executeCommandById(command.id, [])
        })
        return () => {
          dispose()
          this.commandOwners.delete(command.id)
        }
      }, `command:${command.id}`)
    }

    for (const binding of contributes.keybindings ?? []) {
      add(
        () =>
          ctx.keymap.registerBindings([
            {
              id: binding.id,
              keys: binding.keys,
              context: binding.context,
              mode: binding.mode,
              group: binding.group,
              description: binding.description,
              run: () => void this.executeCommandById(binding.command, [])
            }
          ]),
        `keybinding:${binding.id}`
      )
    }

    for (const overlay of contributes.overlays ?? []) {
      add(() => {
        instance.overlayDeclarations.set(overlay.id, overlay)
        this.overlayOwners.set(overlay.id, pluginId)
        return () => {
          instance.overlayDeclarations.delete(overlay.id)
          this.overlayOwners.delete(overlay.id)
        }
      }, `overlay:${overlay.id}`)
    }

    for (const item of contributes.sidebar ?? []) {
      add(
        () =>
          ctx.sidebar.registerLauncher({
            id: item.id,
            label: item.label,
            icon: item.icon,
            order: item.order ?? 100,
            run: () => void this.executeCommandById(item.command, [])
          }),
        `sidebar:${item.id}`
      )
    }

    for (const item of contributes.menu ?? []) {
      add(
        () =>
          ctx.menu.registerItems([
            {
              id: item.id,
              menuId: item.menuId,
              label: item.label,
              group: item.group,
              order: item.order,
              run: () => void this.executeCommandById(item.command, [])
            }
          ]),
        `menu:${item.id}`
      )
    }

    for (const item of contributes.statusBar ?? []) {
      add(() => {
        this.statusItems = {
          ...this.statusItems,
          [item.id]: { text: item.text ?? '', tooltip: item.tooltip, command: item.command }
        }
        const dispose = ctx.statusbar.register({
          id: item.id,
          align: item.align,
          order: item.order ?? 50,
          component: DeclarativeStatusItem,
          props: { itemId: item.id }
        })
        return () => {
          dispose()
          const next = { ...this.statusItems }
          delete next[item.id]
          this.statusItems = next
        }
      }, `status:${item.id}`)
    }

    for (const pane of contributes.panes ?? []) {
      add(() => {
        this.paneOwners.set(pane.id, pluginId)
        const dispose = ctx.panes.register({
          id: pane.id,
          title: pane.title,
          component: DeclarativeSurface
        })
        return () => {
          dispose()
          this.paneOwners.delete(pane.id)
        }
      }, `pane:${pane.id}`)

      if (pane.panel) {
        add(
          () =>
            ctx.panel.registerTab({
              id: pane.id,
              title: pane.panel?.title ?? pane.title,
              paneTypeId: pane.id,
              order: pane.panel?.order
            }),
          `panel:${pane.id}`
        )
      }
    }

    for (const view of contributes.views ?? []) {
      add(
        () =>
          ctx.views.register({
            id: view.id,
            label: view.label,
            order: view.order ?? 50,
            buildTree: () => sanitize(view.tree) ?? createLeaf('nvim')
          }),
        `view:${view.id}`
      )
    }

    if (Array.isArray(contributes.settings) && contributes.settings.length > 0) {
      try {
        add(
          () =>
            ctx.settings.registerSchemas({
              contributorId: pluginId,
              title: manifest.name,
              settings: contributes.settings as SettingDefinition[]
            }),
          'settings'
        )
      } catch (error) {
        console.warn(`plugin ${pluginId}: invalid settings schema`, error)
      }
    }
  }

  // ── Worker→host API methods ───────────────────────────────────
  private registerHostMethods(instance: PluginInstance, rpc: RpcEndpoint): void {
    // Runtime registrations are effects too, keyed so the plugin can revert one
    // on its own through the matching `:dispose` call. Re-registering the same
    // key reverts the previous effect first.
    const track = (key: string, execute: () => () => void): void => {
      const ctx = instance.ctx
      if (!ctx) return
      instance.effects.get(key)?.()
      instance.effects.set(key, ctx.effect(execute, `${instance.record.id}:${key}`))
    }
    const disposeTracked = (key: string): void => {
      instance.effects.get(key)?.()
      instance.effects.delete(key)
    }

    this.registerUiMethods(instance, rpc, track, disposeTracked)
    this.registerWorkspaceMethods(instance, rpc)
    this.registerMainForwarding(instance, rpc)
    this.registerSettingsMethods(instance, rpc)

    // Skill/MCP declarations forward to the main-process AI bridge; the tool
    // handlers stay in the worker and are invoked via event:plugin-tool-call.
    const pluginId = instance.record.id
    const forwardAi = (workerMethod: string, mainMethod: string): void => {
      rpc.handle(workerMethod, async (params) => {
        const callId = `${pluginId}-${Math.random().toString(36).slice(2)}`
        return window.workbench.plugins.invoke(pluginId, callId, mainMethod, params)
      })
    }
    forwardAi('host.registerSkill', 'ai.registerSkill')
    forwardAi('host.registerSkill:dispose', 'ai.disposeSkill')
    forwardAi('host.registerMcpServer', 'ai.registerMcpServer')
    forwardAi('host.registerMcpServer:dispose', 'ai.disposeMcpServer')
    rpc.handle('host.subscribeEvent', async (params) => {
      instance.subscribedEvents.add((params as { event: string }).event)
      return undefined
    })
  }

  private registerUiMethods(
    instance: PluginInstance,
    rpc: RpcEndpoint,
    track: (key: string, execute: () => () => void) => void,
    disposeTracked: (key: string) => void
  ): void {
    const pluginId = instance.record.id
    const ctx = instance.ctx
    if (!ctx) return

    rpc.handle('host.registerCommand', async (params) => {
      const { id } = params as { id: string }
      // Manifest-contributed commands already have a stub; only register new ones.
      if (!this.commandOwners.has(id)) {
        track(`command:${id}`, () => {
          this.commandOwners.set(id, pluginId)
          const dispose = ctx.commands.register({
            id,
            title: id,
            group: instance.record.manifest.name,
            run: () => void this.executeCommandById(id, [])
          })
          return () => {
            dispose()
            this.commandOwners.delete(id)
          }
        })
      }
      return undefined
    })
    rpc.handle('host.registerCommand:dispose', async (params) => {
      disposeTracked(`command:${(params as { id: string }).id}`)
      return undefined
    })

    rpc.handle('host.executeCommand', async (params) => {
      const { id, args } = params as { id: string; args: unknown[] }
      return this.executeCommandById(id, args ?? [])
    })

    rpc.handle('host.registerKeybinding', async (params) => {
      const binding = params as {
        id: string
        keys: string
        context?: string
        group?: string
        description: string
        command: string
      }
      track(`keybinding:${binding.id}`, () =>
        ctx.keymap.registerBindings([
          { ...binding, run: () => void this.executeCommandById(binding.command, []) }
        ])
      )
      return undefined
    })
    rpc.handle('host.registerKeybinding:dispose', async (params) => {
      disposeTracked(`keybinding:${(params as { id: string }).id}`)
      return undefined
    })

    rpc.handle('host.registerOverlay', async (params) => {
      const declaration = params as OverlayDeclaration
      instance.overlayDeclarations.set(declaration.id, declaration)
      this.overlayOwners.set(declaration.id, pluginId)
      return undefined
    })
    rpc.handle('host.registerOverlay:dispose', async (params) => {
      const { id } = params as { id: string }
      instance.overlayDeclarations.delete(id)
      this.overlayOwners.delete(id)
      return undefined
    })
    rpc.handle('host.openOverlay', async (params) => {
      this.openPluginOverlay(instance, (params as { id: string }).id)
      return undefined
    })
    rpc.handle('host.closeOverlay', async (params) => {
      const overlayId = `plugin:${pluginId}:${(params as { id: string }).id}`
      if (overlays.isOpen(overlayId)) overlays.cancel()
      return undefined
    })

    rpc.handle('host.addStatusBarItem', async (params) => {
      const item = params as {
        id: string
        align: 'left' | 'right'
        order?: number
        text: string
        tooltip?: string
        command?: string
      }
      track(`status:${item.id}`, () => {
        this.statusItems = {
          ...this.statusItems,
          [item.id]: { text: item.text, tooltip: item.tooltip, command: item.command }
        }
        const dispose = ctx.statusbar.register({
          id: item.id,
          align: item.align,
          order: item.order ?? 50,
          component: DeclarativeStatusItem,
          props: { itemId: item.id }
        })
        return () => {
          dispose()
          const next = { ...this.statusItems }
          delete next[item.id]
          this.statusItems = next
        }
      })
      return undefined
    })
    rpc.handle('host.addStatusBarItem:dispose', async (params) => {
      disposeTracked(`status:${(params as { id: string }).id}`)
      return undefined
    })
    rpc.handle('host.updateStatusBarItem', async (params) => {
      const { id, patch } = params as { id: string; patch: Partial<HostStatusItem> }
      const current = this.statusItems[id]
      if (!current) return undefined
      this.statusItems = { ...this.statusItems, [id]: { ...current, ...patch } }
      return undefined
    })

    rpc.handle('host.addSidebarItem', async (params) => {
      const item = params as { id: string; label: string; icon: string; order?: number; command: string }
      track(`sidebar:${item.id}`, () =>
        ctx.sidebar.registerLauncher({
          id: item.id,
          label: item.label,
          icon: item.icon,
          order: item.order ?? 100,
          run: () => void this.executeCommandById(item.command, [])
        })
      )
      return undefined
    })
    rpc.handle('host.addSidebarItem:dispose', async (params) => {
      disposeTracked(`sidebar:${(params as { id: string }).id}`)
      return undefined
    })

    rpc.handle('host.addMenuItem', async (params) => {
      const item = params as {
        id: string
        menuId: string
        label: string
        group?: string
        order?: number
        command: string
      }
      track(`menu:${item.id}`, () =>
        ctx.menu.registerItems([
          { ...item, run: () => void this.executeCommandById(item.command, []) }
        ])
      )
      return undefined
    })
    rpc.handle('host.addMenuItem:dispose', async (params) => {
      disposeTracked(`menu:${(params as { id: string }).id}`)
      return undefined
    })

    rpc.handle('host.registerPaneType', async (params) => {
      const { id } = params as { id: string }
      track(`pane:${id}`, () => {
        this.paneOwners.set(id, pluginId)
        const dispose = ctx.panes.register({ id, title: id, component: DeclarativeSurface })
        return () => {
          dispose()
          this.paneOwners.delete(id)
        }
      })
      return undefined
    })
    rpc.handle('host.registerPaneType:dispose', async (params) => {
      disposeTracked(`pane:${(params as { id: string }).id}`)
      return undefined
    })
    rpc.handle('host.updatePane', async (params) => {
      const { id } = params as { id: string }
      this.paneVersions = { ...this.paneVersions, [id]: (this.paneVersions[id] ?? 0) + 1 }
      return undefined
    })

    rpc.handle('host.registerView', async (params) => {
      const view = params as { id: string; label: string; order?: number; tree: unknown }
      track(`view:${view.id}`, () =>
        ctx.views.register({
          id: view.id,
          label: view.label,
          order: view.order ?? 50,
          buildTree: () => sanitize(view.tree) ?? createLeaf('nvim')
        })
      )
      return undefined
    })
    rpc.handle('host.registerView:dispose', async (params) => {
      disposeTracked(`view:${(params as { id: string }).id}`)
      return undefined
    })

    rpc.handle('host.confirmDialog', async (params) => {
      const options = params as {
        title: string
        body: string
        detail?: string
        actions: { id: string; label: string; kind?: 'primary' | 'danger' | 'default' }[]
      }
      return dialogs.confirm({
        ...options,
        title: `${instance.record.manifest.name}: ${options.title}`
      })
    })
    rpc.handle('host.notify', async (params) => {
      const options = params as { level: 'info' | 'warn' | 'error'; message: string; timeoutMs?: number }
      dialogs.notify({ ...options, message: `${instance.record.manifest.name}: ${options.message}` })
      return undefined
    })
  }

  private registerWorkspaceMethods(instance: PluginInstance, rpc: RpcEndpoint): void {
    const ctx = instance.ctx

    rpc.handle('host.getCurrentWorktree', async () => {
      const worktree = store.selectedWorktree
      if (!worktree) return null
      return { id: worktree.id, path: worktree.path, branch: worktree.branch }
    })

    rpc.handle('host.getActiveFile', async () => {
      // Through the editor service when the fiber is live, so a plugin cannot
      // reach the buffer of an editor that has been unloaded.
      const session = ctx ? ctx.editor.activeSession() : activeNvimSession()
      if (!session) return null
      const active = await session.getActiveFile()
      if (!active) return null
      // Return a worktree-relative path so it composes with readExcerpt/openFile,
      // which resolve relative paths against the active worktree base.
      const base = store.selectedWorktree?.path ?? ''
      return { path: relativePath(base, active.path), line: active.line }
    })

    rpc.handle('host.openFile', async (params) => {
      const { path, worktreeId, line } = params as {
        path: string
        worktreeId?: string
        line?: number
      }
      const targetWorktreeId = worktreeId ?? store.selectedWorktreeId
      if (!targetWorktreeId) return undefined
      const worktree = store.worktrees.find((entry) => entry.id === targetWorktreeId)
      const absPath = isAbsolutePath(path) ? path : joinPath(worktree?.path ?? '', path)
      if (typeof line === 'number') openFileAtLine(targetWorktreeId, absPath, line)
      else openFileInEditor(targetWorktreeId, absPath)
      return undefined
    })
  }

  // Forward every 'main.*' method to the api dispatcher in the main process;
  // the host stamps pluginId + worktreeId and bridges streaming chunks back.
  // Generic on purpose: the main-process route registry is the single
  // authority on which methods exist, their scopes, and their transports.
  private registerMainForwarding(instance: PluginInstance, rpc: RpcEndpoint): void {
    const pluginId = instance.record.id
    rpc.setFallbackHandler(async (fullMethod, params, context) => {
      if (!fullMethod.startsWith('main.')) {
        throw new Error(`unknown method: ${fullMethod}`)
      }
      const method = fullMethod.slice('main.'.length)
      const callId = `${pluginId}-${Math.random().toString(36).slice(2)}`
      // Default the worktree to the active one. Spread can't set the default
      // because callers pass an explicit `worktreeId: undefined`, which would
      // override it — patch it in afterwards when absent.
      const args = { ...(params as { worktreeId?: string | null }) }
      if (args.worktreeId == null) args.worktreeId = store.selectedWorktreeId
      if (!context.streaming) {
        return window.workbench.plugins.invoke(pluginId, callId, method, args)
      }

      const done = new Promise<void>((resolve, reject) => {
        instance.mainStreams.set(callId, {
          emit: context.emit,
          finish: (error) => {
            instance.mainStreams.delete(callId)
            if (error) reject(error)
            else resolve()
          }
        })
      })
      context.token.onCancel(() => void window.workbench.plugins.cancel(pluginId, callId))
      await window.workbench.plugins.invoke(pluginId, callId, method, args)
      await done
      return undefined
    })
  }

  private registerSettingsMethods(instance: PluginInstance, rpc: RpcEndpoint): void {
    rpc.handle('host.getSetting', async (params) => {
      return settings.get((params as { key: string }).key)
    })
    rpc.handle('host.setSetting', async (params) => {
      const { key, value, scope } = params as {
        key: string
        value: unknown
        scope?: 'user' | 'project'
      }
      await settings.set(key, value, scope ?? 'user')
      return undefined
    })
    rpc.handle('host.watchSetting', async (params) => {
      const { key } = params as { key: string }
      const ctx = instance.ctx
      if (!ctx) return undefined
      if (instance.watchedSettings.has(key)) return undefined
      instance.watchedSettings.add(key)
      const watchKey = `setting-watch:${key}`
      instance.effects.set(
        watchKey,
        ctx.effect(() => {
          const dispose = settings.onChange(key, (value) => {
            instance.rpc?.event('settings:changed', { key, value })
          })
          return () => {
            dispose()
            instance.watchedSettings.delete(key)
          }
        }, `${instance.record.id}:${watchKey}`)
      )
      return undefined
    })
  }

  // Agent-run MCP tool call → invoke the plugin worker's handler and reply.
  private async onPluginToolCall(payload: unknown): Promise<void> {
    const request = payload as { id: string; pluginId: string; tool: string; input: unknown }
    try {
      await this.ensureActivated(request.pluginId)
      const instance = this.instances.get(request.pluginId)
      if (!instance?.rpc) throw new Error('plugin not running')
      const result = await instance.rpc.request('mcp:invokeTool', {
        tool: request.tool,
        input: request.input
      })
      await window.workbench.plugins.respondToolCall(request.id, result)
    } catch (error) {
      await window.workbench.plugins.respondToolCall(
        request.id,
        null,
        (error as Error).message
      )
    }
  }

  private onMainStream(payload: unknown): void {
    const event = payload as {
      pluginId: string
      callId: string
      chunk?: unknown
      end?: boolean
      error?: { message: string }
    }
    const instance = this.instances.get(event.pluginId)
    const stream = instance?.mainStreams.get(event.callId)
    if (!stream) return
    if (event.chunk !== undefined) stream.emit(event.chunk)
    if (event.end) stream.finish(event.error ? new Error(event.error.message) : undefined)
  }

  // ── Plugin overlays (bridged onto the canonical overlay) ──────
  openPluginOverlay(instance: PluginInstance, overlayId: string): void {
    const declaration = instance.overlayDeclarations.get(overlayId)
    if (!declaration) {
      dialogs.notify({ level: 'error', message: `Unknown overlay "${overlayId}"` })
      return
    }
    const rpcOf = (): RpcEndpoint | null => instance.rpc
    overlays.show({
      id: `plugin:${instance.record.id}:${overlayId}`,
      placeholder: declaration.placeholder ?? declaration.title,
      multiSelect: declaration.multiSelect,
      debounceMs: declaration.debounceMs,
      onQuery: async (query, emit, token) => {
        await this.ensureActivated(instance.record.id)
        const rpc = rpcOf()
        if (!rpc) return
        const handle = rpc.requestStream('overlay:query', { overlayId, query }, (chunk) =>
          emit(chunk as OverlayItem[])
        )
        token.onCancel(() => handle.cancel())
        await handle.done.catch(() => {})
      },
      onPreview: declaration.preview
        ? async (item) => {
            const rpc = rpcOf()
            if (!rpc) return null
            // Snapshot: overlay items live in $state, and reactive proxies
            // cannot be structured-cloned across the worker boundary.
            const content = await rpc.request('overlay:preview', {
              overlayId,
              item: $state.snapshot(item)
            })
            return content as OverlayPreviewContent | null
          }
        : undefined,
      onAccept: async (items) => {
        await rpcOf()?.request('overlay:accept', { overlayId, items: $state.snapshot(items) })
      }
    })
  }

  // Open a plugin overlay by id from anywhere in the app (commands).
  openOverlayById(overlayId: string): void {
    const ownerId = this.overlayOwners.get(overlayId)
    const instance = ownerId ? this.instances.get(ownerId) : null
    if (instance) this.openPluginOverlay(instance, overlayId)
  }

  private owningInstance(pluginId: string | undefined): PluginInstance | null {
    if (!pluginId) return null
    return this.instances.get(pluginId) ?? null
  }
}

export const pluginHost = new PluginHost()
