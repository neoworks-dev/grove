// PermissionBroker: the single gate between plugins and privileged
// capabilities. Grants persist in plugin-grants.json (separate from workbench
// state); undeclared permissions hard-fail; builtins are auto-granted; project
// plugins additionally need one-time trust per id@version.

import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import type { PluginManifest, PluginPermission } from '../../shared/plugins'

export interface PluginPermissionRequest {
  id: string
  pluginId: string
  pluginName: string
  permission: PluginPermission
  detail: string
}

export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny-once' | 'deny-always'

interface PluginGrants {
  permissions: Partial<Record<PluginPermission, 'granted' | 'denied'>>
  fsScopes: string[]
}

interface GrantStore {
  plugins: Record<string, PluginGrants>
  trustedProjectPlugins: Record<string, string[]> // repoPath -> ["id@version"]
  disabledPlugins: string[]
}

const EMPTY_STORE: GrantStore = { plugins: {}, trustedProjectPlugins: {}, disabledPlugins: [] }

function grantsPath(): string {
  return join(app.getPath('userData'), 'plugin-grants.json')
}

export class PermissionError extends Error {
  code = 'permission-denied' as const
}

interface BrokerEvents {
  onPermissionRequest: (request: PluginPermissionRequest) => void
}

interface BrokerPlugin {
  manifest: PluginManifest
  source: 'builtin' | 'user' | 'project'
}

export class PermissionBroker {
  private events: BrokerEvents
  private cache: GrantStore | null = null
  private pending = new Map<string, (decision: PermissionDecision) => void>()
  // Coalesce identical concurrent requests so one dialog answers them all.
  private inFlight = new Map<string, Promise<boolean>>()
  private requestCounter = 0

  constructor(events: BrokerEvents) {
    this.events = events
  }

  private async store(): Promise<GrantStore> {
    if (this.cache) return this.cache
    let loaded: GrantStore
    try {
      const text = await readFile(grantsPath(), 'utf8')
      loaded = { ...EMPTY_STORE, ...JSON.parse(text) }
    } catch {
      loaded = structuredClone(EMPTY_STORE)
    }
    this.cache = loaded
    return loaded
  }

  private async save(): Promise<void> {
    if (!this.cache) return
    await mkdir(dirname(grantsPath()), { recursive: true })
    await writeFile(grantsPath(), JSON.stringify(this.cache, null, 2), 'utf8')
  }

  // Throws PermissionError unless the plugin may use the permission.
  async ensure(plugin: BrokerPlugin, permission: PluginPermission, detail: string): Promise<void> {
    const declared = plugin.manifest.permissions ?? []
    if (!declared.includes(permission)) {
      throw new PermissionError(`${plugin.manifest.id} does not declare "${permission}"`)
    }
    if (plugin.source === 'builtin') return
    const store = await this.store()
    const stored = store.plugins[plugin.manifest.id]?.permissions[permission]
    if (stored === 'granted') return
    if (stored === 'denied') {
      throw new PermissionError(`"${permission}" denied for ${plugin.manifest.id}`)
    }
    const allowed = await this.prompt(plugin, permission, detail)
    if (!allowed) throw new PermissionError(`"${permission}" denied for ${plugin.manifest.id}`)
  }

  // Path-scoped file access: paths inside the active worktree ride the blanket
  // workspace grant; anything outside every granted scope prompts per request.
  async ensurePath(
    plugin: BrokerPlugin,
    mode: 'read' | 'write',
    absPath: string,
    worktreeRoot: string
  ): Promise<void> {
    const permission: PluginPermission = mode === 'read' ? 'workspace.read' : 'workspace.write'
    await this.ensure(plugin, permission, absPath)
    const target = resolve(absPath)
    if (isInside(worktreeRoot, target)) return
    const store = await this.store()
    const scopes = store.plugins[plugin.manifest.id]?.fsScopes ?? []
    if (scopes.some((scope) => isInside(scope, target))) return
    if (plugin.source === 'builtin') return
    const allowed = await this.prompt(plugin, permission, `${mode} outside workspace: ${target}`)
    if (!allowed) throw new PermissionError(`path access denied: ${target}`)
  }

  private prompt(
    plugin: BrokerPlugin,
    permission: PluginPermission,
    detail: string
  ): Promise<boolean> {
    const coalesceKey = `${plugin.manifest.id}:${permission}:${detail}`
    const existing = this.inFlight.get(coalesceKey)
    if (existing) return existing
    const promise = this.promptOnce(plugin, permission, detail).finally(() => {
      this.inFlight.delete(coalesceKey)
    })
    this.inFlight.set(coalesceKey, promise)
    return promise
  }

  private async promptOnce(
    plugin: BrokerPlugin,
    permission: PluginPermission,
    detail: string
  ): Promise<boolean> {
    this.requestCounter += 1
    const id = `plugin-perm-${this.requestCounter}`
    const decision = await new Promise<PermissionDecision>((resolvePromise) => {
      this.pending.set(id, resolvePromise)
      this.events.onPermissionRequest({
        id,
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.name,
        permission,
        detail
      })
    })
    if (decision === 'allow-always' || decision === 'deny-always') {
      await this.persistDecision(plugin.manifest.id, permission, decision)
    }
    return decision === 'allow-once' || decision === 'allow-always'
  }

  private async persistDecision(
    pluginId: string,
    permission: PluginPermission,
    decision: 'allow-always' | 'deny-always'
  ): Promise<void> {
    const store = await this.store()
    const grants = store.plugins[pluginId] ?? { permissions: {}, fsScopes: [] }
    grants.permissions[permission] = decision === 'allow-always' ? 'granted' : 'denied'
    store.plugins[pluginId] = grants
    await this.save()
  }

  respondPermission(id: string, decision: PermissionDecision): void {
    const resolver = this.pending.get(id)
    if (!resolver) return
    this.pending.delete(id)
    resolver(decision)
  }

  // ── Project trust ─────────────────────────────────────────────
  async isProjectPluginTrusted(repoPath: string, manifest: PluginManifest): Promise<boolean> {
    const store = await this.store()
    const trusted = store.trustedProjectPlugins[repoPath] ?? []
    return trusted.includes(`${manifest.id}@${manifest.version}`)
  }

  async trustProjectPlugin(repoPath: string, manifest: PluginManifest): Promise<void> {
    const store = await this.store()
    const trusted = store.trustedProjectPlugins[repoPath] ?? []
    const key = `${manifest.id}@${manifest.version}`
    if (!trusted.includes(key)) trusted.push(key)
    store.trustedProjectPlugins[repoPath] = trusted
    await this.save()
  }

  // ── Enable/disable ────────────────────────────────────────────
  async isEnabled(pluginId: string): Promise<boolean> {
    const store = await this.store()
    return !store.disabledPlugins.includes(pluginId)
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const store = await this.store()
    const without = store.disabledPlugins.filter((id) => id !== pluginId)
    store.disabledPlugins = enabled ? without : [...without, pluginId]
    await this.save()
  }
}

export function isInside(root: string, target: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep)
}
