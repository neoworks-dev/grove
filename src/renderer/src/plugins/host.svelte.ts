// PluginHost: loads plugin records, registers their manifest contributions as
// lazy stubs into the canonical registries, and manages one sandboxed Web
// Worker per activated plugin. All worker→host API calls land here; privileged
// ones forward to main over plugin-scoped IPC (pluginId stamped by this host,
// never by the worker).

import type { PluginManifest } from '../../../shared/plugins'
import { GROVE_API_VERSION } from '../../../shared/plugins'
import { RpcEndpoint } from './rpc'
import { commands } from '../lib/commands.svelte'
import { keymap } from '../lib/keymap.svelte'
import { overlays, type OverlayItem, type OverlayPreviewContent } from '../lib/overlays.svelte'
import { statusBar } from '../lib/statusbar.svelte'
import { sidebar } from '../lib/sidebar.svelte'
import { menu } from '../lib/menu.svelte'
import { panes } from '../lib/panes.svelte'
import { views } from '../lib/views.svelte'
import { settings } from '../lib/settings.svelte'
import { dialogs } from '../lib/dialogs.svelte'
import { layout } from '../lib/layout.svelte'
import { store, openFileInEditor, openFileAtLine } from '../lib/store.svelte'
import { sanitize, createLeaf } from '../lib/layoutTree'
import { isAbsolutePath, joinPath } from '../lib/paths'
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
  worker: Worker | null
  rpc: RpcEndpoint | null
  activating: Promise<void> | null
  runtimeError: string | null
  contributionDisposers: (() => void)[]
  runtimeDisposers: Map<string, () => void>
  overlayDeclarations: Map<string, OverlayDeclaration>
  mainStreams: Map<string, MainStream>
  subscribedEvents: Set<string>
  watchedSettings: Set<string>
  // Skill/MCP declarations stashed for the AI bridge (wired in a later phase).
  mcpServers: Map<string, unknown>
  skills: Map<string, unknown>
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
    const command = commands.commands.find((entry) => entry.id === commandId)
    if (command) return command.run()
    dialogs.notify({ level: 'error', message: `Unknown command "${commandId}"` })
    return undefined
  }

  // ── Lifecycle ─────────────────────────────────────────────────
  async init(): Promise<void> {
    window.workbench.on('event:plugin-stream', (payload) => this.onMainStream(payload))
    window.workbench.on('event:plugin-permission', (payload) => void this.onPermissionRequest(payload))
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
      this.disposeInstance(instance)
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
      worker: null,
      rpc: null,
      activating: null,
      runtimeError: null,
      contributionDisposers: [],
      runtimeDisposers: new Map(),
      overlayDeclarations: new Map(),
      mainStreams: new Map(),
      subscribedEvents: new Set(),
      watchedSettings: new Set(),
      mcpServers: new Map(),
      skills: new Map()
    }
    this.instances.set(record.id, instance)
    this.contribute(instance)
    if ((record.manifest.activation ?? ['onStartup']).includes('onStartup')) {
      void this.ensureActivated(record.id)
    }
  }

  private disposeInstance(instance: PluginInstance): void {
    for (const dispose of instance.contributionDisposers) dispose()
    for (const dispose of instance.runtimeDisposers.values()) dispose()
    instance.contributionDisposers = []
    instance.runtimeDisposers.clear()
    instance.rpc?.failAllPending('plugin disposed')
    instance.worker?.terminate()
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

  // ── Activation ────────────────────────────────────────────────
  async ensureActivated(pluginId: string): Promise<void> {
    const instance = this.instances.get(pluginId)
    if (!instance) throw new Error(`plugin not loaded: ${pluginId}`)
    if (instance.rpc) return
    if (instance.activating) return instance.activating
    instance.activating = this.activate(instance)
    return instance.activating
  }

  private activate(instance: PluginInstance): Promise<void> {
    const worker = new Worker(new URL('./sandbox/bootstrap.ts', import.meta.url), {
      type: 'module'
    })
    const rpc = new RpcEndpoint((message) => worker.postMessage(message), 'even')
    this.registerHostMethods(instance, rpc)
    instance.worker = worker
    instance.rpc = rpc

    return new Promise((resolve, reject) => {
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
    })
  }

  private crash(instance: PluginInstance, message: string): void {
    instance.runtimeError = message
    dialogs.notify({ level: 'error', message: `Plugin ${instance.record.id}: ${message}` })
    this.disposeInstance(instance)
  }

  async deactivate(pluginId: string): Promise<void> {
    const instance = this.instances.get(pluginId)
    if (!instance?.rpc) return
    await Promise.race([
      instance.rpc.request('lifecycle:deactivate', {}),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]).catch(() => {})
    this.disposeInstance(instance)
  }

  // ── Manifest contributions (lazy stubs, registered before activation) ──
  private contribute(instance: PluginInstance): void {
    const { manifest } = instance.record
    const contributes = manifest.contributes ?? {}
    const add = (dispose: () => void): void => {
      instance.contributionDisposers.push(dispose)
    }

    for (const command of contributes.commands ?? []) {
      this.commandOwners.set(command.id, instance.record.id)
      add(
        commands.register({
          id: command.id,
          title: command.title,
          group: command.group,
          keywords: command.keywords,
          run: () => void this.executeCommandById(command.id, [])
        })
      )
      add(() => this.commandOwners.delete(command.id))
    }

    for (const binding of contributes.keybindings ?? []) {
      add(
        keymap.registerBindings([
          {
            id: binding.id,
            keys: binding.keys,
            context: binding.context,
            group: binding.group,
            description: binding.description,
            run: () => void this.executeCommandById(binding.command, [])
          }
        ])
      )
    }

    for (const overlay of contributes.overlays ?? []) {
      instance.overlayDeclarations.set(overlay.id, overlay)
      this.overlayOwners.set(overlay.id, instance.record.id)
      add(() => {
        instance.overlayDeclarations.delete(overlay.id)
        this.overlayOwners.delete(overlay.id)
      })
    }

    for (const item of contributes.sidebar ?? []) {
      add(
        sidebar.register({
          id: item.id,
          label: item.label,
          icon: item.icon,
          order: item.order ?? 100,
          run: () => void this.executeCommandById(item.command, [])
        })
      )
    }

    for (const item of contributes.menu ?? []) {
      add(
        menu.registerItems([
          {
            id: item.id,
            menuId: item.menuId,
            label: item.label,
            group: item.group,
            order: item.order,
            run: () => void this.executeCommandById(item.command, [])
          }
        ])
      )
    }

    for (const item of contributes.statusBar ?? []) {
      this.statusItems = {
        ...this.statusItems,
        [item.id]: { text: item.text ?? '', tooltip: item.tooltip, command: item.command }
      }
      add(
        statusBar.register({
          id: item.id,
          align: item.align,
          order: item.order ?? 50,
          component: DeclarativeStatusItem,
          props: { itemId: item.id }
        })
      )
    }

    for (const pane of contributes.panes ?? []) {
      this.paneOwners.set(pane.id, instance.record.id)
      add(
        panes.register({
          id: pane.id,
          title: pane.title,
          component: DeclarativeSurface
        })
      )
      add(() => this.paneOwners.delete(pane.id))
    }

    for (const view of contributes.views ?? []) {
      add(
        views.register({
          id: view.id,
          label: view.label,
          order: view.order ?? 50,
          buildTree: () => sanitize(view.tree) ?? createLeaf('editor')
        })
      )
    }

    if (Array.isArray(contributes.settings) && contributes.settings.length > 0) {
      try {
        add(
          settings.registerSchemas({
            contributorId: instance.record.id,
            title: manifest.name,
            settings: contributes.settings as SettingDefinition[]
          })
        )
      } catch (error) {
        console.warn(`plugin ${instance.record.id}: invalid settings schema`, error)
      }
    }
  }

  // ── Worker→host API methods ───────────────────────────────────
  private registerHostMethods(instance: PluginInstance, rpc: RpcEndpoint): void {
    const track = (key: string, dispose: () => void): void => {
      instance.runtimeDisposers.get(key)?.()
      instance.runtimeDisposers.set(key, dispose)
    }
    const disposeTracked = (key: string): void => {
      instance.runtimeDisposers.get(key)?.()
      instance.runtimeDisposers.delete(key)
    }

    this.registerUiMethods(instance, rpc, track, disposeTracked)
    this.registerWorkspaceMethods(instance, rpc)
    this.registerMainForwarding(instance, rpc)
    this.registerSettingsMethods(instance, rpc)

    rpc.handle('host.registerSkill', async (params) => {
      const skill = params as { name: string }
      instance.skills.set(skill.name, params)
      return undefined
    })
    rpc.handle('host.registerSkill:dispose', async (params) => {
      instance.skills.delete((params as { id: string }).id)
      return undefined
    })
    rpc.handle('host.registerMcpServer', async (params) => {
      const server = params as { name: string }
      instance.mcpServers.set(server.name, params)
      return undefined
    })
    rpc.handle('host.registerMcpServer:dispose', async (params) => {
      instance.mcpServers.delete((params as { id: string }).id)
      return undefined
    })
    rpc.handle('host.subscribeEvent', async (params) => {
      instance.subscribedEvents.add((params as { event: string }).event)
      return undefined
    })
  }

  private registerUiMethods(
    instance: PluginInstance,
    rpc: RpcEndpoint,
    track: (key: string, dispose: () => void) => void,
    disposeTracked: (key: string) => void
  ): void {
    const pluginId = instance.record.id

    rpc.handle('host.registerCommand', async (params) => {
      const { id } = params as { id: string }
      // Manifest-contributed commands already have a stub; only register new ones.
      if (!this.commandOwners.has(id)) {
        this.commandOwners.set(id, pluginId)
        track(
          `command:${id}`,
          commands.register({
            id,
            title: id,
            group: instance.record.manifest.name,
            run: () => void this.executeCommandById(id, [])
          })
        )
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
      track(
        `keybinding:${binding.id}`,
        keymap.registerBindings([
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
      this.statusItems = {
        ...this.statusItems,
        [item.id]: { text: item.text, tooltip: item.tooltip, command: item.command }
      }
      track(
        `status:${item.id}`,
        statusBar.register({
          id: item.id,
          align: item.align,
          order: item.order ?? 50,
          component: DeclarativeStatusItem,
          props: { itemId: item.id }
        })
      )
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
      track(
        `sidebar:${item.id}`,
        sidebar.register({
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
      track(
        `menu:${item.id}`,
        menu.registerItems([
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
      this.paneOwners.set(id, pluginId)
      track(`pane:${id}`, panes.register({ id, title: id, component: DeclarativeSurface }))
      return undefined
    })
    rpc.handle('host.registerPaneType:dispose', async (params) => {
      const { id } = params as { id: string }
      disposeTracked(`pane:${id}`)
      this.paneOwners.delete(id)
      return undefined
    })
    rpc.handle('host.updatePane', async (params) => {
      const { id } = params as { id: string }
      this.paneVersions = { ...this.paneVersions, [id]: (this.paneVersions[id] ?? 0) + 1 }
      return undefined
    })

    rpc.handle('host.registerView', async (params) => {
      const view = params as { id: string; label: string; order?: number; tree: unknown }
      track(
        `view:${view.id}`,
        views.register({
          id: view.id,
          label: view.label,
          order: view.order ?? 50,
          buildTree: () => sanitize(view.tree) ?? createLeaf('editor')
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
    rpc.handle('host.getCurrentWorktree', async () => {
      const worktree = store.selectedWorktree
      if (!worktree) return null
      return { id: worktree.id, path: worktree.path, branch: worktree.branch }
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

  // Forward 'main.*' methods to the plugin router in the main process; the
  // host stamps pluginId + worktreeId and bridges streaming chunks back.
  private registerMainForwarding(instance: PluginInstance, rpc: RpcEndpoint): void {
    const pluginId = instance.record.id
    const forward = (method: string): void => {
      rpc.handle(`main.${method}`, async (params, context) => {
        const callId = `${pluginId}-${Math.random().toString(36).slice(2)}`
        const args = { worktreeId: store.selectedWorktreeId, ...(params as object) }
        const streaming = method === 'workspace.searchText'
        if (!streaming) return window.workbench.plugins.invoke(pluginId, callId, method, args)

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
    forward('workspace.findFiles')
    forward('workspace.readFile')
    forward('workspace.readExcerpt')
    forward('workspace.writeFile')
    forward('workspace.searchText')
    forward('storage.get')
    forward('storage.set')
    forward('storage.delete')
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
      if (instance.watchedSettings.has(key)) return undefined
      instance.watchedSettings.add(key)
      const dispose = settings.onChange(key, (value) => {
        instance.rpc?.event('settings:changed', { key, value })
      })
      instance.runtimeDisposers.set(`setting-watch:${key}`, dispose)
      return undefined
    })
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
            const content = await rpc.request('overlay:preview', { overlayId, item })
            return content as OverlayPreviewContent | null
          }
        : undefined,
      onAccept: async (items) => {
        await rpcOf()?.request('overlay:accept', { overlayId, items })
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
