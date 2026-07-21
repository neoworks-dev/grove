// PermissionBroker: the single gate between API clients (plugins + external
// apps) and privileged capabilities. Plugin grants persist in
// plugin-grants.json (separate from workbench state); undeclared scopes
// hard-fail; builtins are auto-granted; project plugins additionally need
// one-time trust per id@version. App grants live in the pairing store and are
// wired in via sectionKey (external-apps.json, socket transport milestone).

import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import type { PluginManifest, PluginPermission } from '../../shared/plugins'
import type { ClientRecord, ClientKind } from './clients'

export interface PluginPermissionRequest {
  id: string
  pluginId: string
  pluginName: string
  permission: PluginPermission
  detail: string
  // Additive: lets the renderer dialog distinguish "Plugin X" from
  // "External app X". Absent in payloads persisted before this field existed.
  clientKind?: ClientKind
  clientKey?: string
}

export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny-once' | 'deny-always'

interface ClientGrants {
  permissions: Partial<Record<PluginPermission, 'granted' | 'denied'>>
  fsScopes: string[]
}

interface GrantStore {
  plugins: Record<string, ClientGrants>
  trustedProjectPlugins: Record<string, string[]> // repoPath -> ["id@version"]
  disabledPlugins: string[]
}

const EMPTY_STORE: GrantStore = { plugins: {}, trustedProjectPlugins: {}, disabledPlugins: [] }

export class PermissionError extends Error {
  code = 'permission-denied' as const
}

interface BrokerEvents {
  onPermissionRequest: (request: PluginPermissionRequest) => void
}

interface BrokerOptions {
  // Overridable for tests; defaults to <userData>/plugin-grants.json.
  grantsPath?: string
}

export class PermissionBroker {
  private events: BrokerEvents
  private grantsFilePath: string | null
  private cache: GrantStore | null = null
  private pending = new Map<string, (decision: PermissionDecision) => void>()
  // Coalesce identical concurrent requests so one dialog answers them all.
  private inFlight = new Map<string, Promise<boolean>>()
  private requestCounter = 0

  constructor(events: BrokerEvents, options: BrokerOptions = {}) {
    this.events = events
    this.grantsFilePath = options.grantsPath ?? null
  }

  private grantsPath(): string {
    if (this.grantsFilePath) return this.grantsFilePath
    return join(app.getPath('userData'), 'plugin-grants.json')
  }

  // Plugin grants stay keyed by bare plugin id (byte-compatible with existing
  // plugin-grants.json); app grants get the prefixed key so kinds can't
  // collide once the pairing store delegates here.
  private sectionKey(client: ClientRecord): string {
    if (client.kind === 'plugin') return client.id
    return client.key
  }

  private async store(): Promise<GrantStore> {
    if (this.cache) return this.cache
    let loaded: GrantStore
    try {
      const text = await readFile(this.grantsPath(), 'utf8')
      loaded = { ...EMPTY_STORE, ...JSON.parse(text) }
    } catch {
      loaded = structuredClone(EMPTY_STORE)
    }
    this.cache = loaded
    return loaded
  }

  private async save(): Promise<void> {
    if (!this.cache) return
    await mkdir(dirname(this.grantsPath()), { recursive: true })
    await writeFile(this.grantsPath(), JSON.stringify(this.cache, null, 2), 'utf8')
  }

  // Throws PermissionError unless the client may use the permission.
  async ensure(client: ClientRecord, permission: PluginPermission, detail: string): Promise<void> {
    if (!client.declaredScopes.includes(permission)) {
      throw new PermissionError(`${client.id} does not declare "${permission}"`)
    }
    if (client.source === 'builtin') return
    const store = await this.store()
    const stored = store.plugins[this.sectionKey(client)]?.permissions[permission]
    if (stored === 'granted') return
    if (stored === 'denied') {
      throw new PermissionError(`"${permission}" denied for ${client.id}`)
    }
    const allowed = await this.prompt(client, permission, detail)
    if (!allowed) throw new PermissionError(`"${permission}" denied for ${client.id}`)
  }

  // Path-scoped file access: paths inside the active worktree ride the blanket
  // workspace grant; anything outside every granted scope prompts per request.
  async ensurePath(
    client: ClientRecord,
    mode: 'read' | 'write',
    absPath: string,
    worktreeRoot: string
  ): Promise<void> {
    const permission: PluginPermission = mode === 'read' ? 'workspace.read' : 'workspace.write'
    await this.ensure(client, permission, absPath)
    const target = resolve(absPath)
    if (isInside(worktreeRoot, target)) return
    const store = await this.store()
    const scopes = store.plugins[this.sectionKey(client)]?.fsScopes ?? []
    if (scopes.some((scope) => isInside(scope, target))) return
    if (client.source === 'builtin') return
    const allowed = await this.prompt(client, permission, `${mode} outside workspace: ${target}`)
    if (!allowed) throw new PermissionError(`path access denied: ${target}`)
  }

  private prompt(
    client: ClientRecord,
    permission: PluginPermission,
    detail: string
  ): Promise<boolean> {
    const coalesceKey = `${client.key}:${permission}:${detail}`
    const existing = this.inFlight.get(coalesceKey)
    if (existing) return existing
    const promise = this.promptOnce(client, permission, detail).finally(() => {
      this.inFlight.delete(coalesceKey)
    })
    this.inFlight.set(coalesceKey, promise)
    return promise
  }

  private async promptOnce(
    client: ClientRecord,
    permission: PluginPermission,
    detail: string
  ): Promise<boolean> {
    this.requestCounter += 1
    const id = `plugin-perm-${this.requestCounter}`
    const decision = await new Promise<PermissionDecision>((resolvePromise) => {
      this.pending.set(id, resolvePromise)
      this.events.onPermissionRequest({
        id,
        pluginId: client.id,
        pluginName: client.name,
        permission,
        detail,
        clientKind: client.kind,
        clientKey: client.key
      })
    })
    if (decision === 'allow-always' || decision === 'deny-always') {
      await this.persistDecision(client, permission, decision)
    }
    return decision === 'allow-once' || decision === 'allow-always'
  }

  private async persistDecision(
    client: ClientRecord,
    permission: PluginPermission,
    decision: 'allow-always' | 'deny-always'
  ): Promise<void> {
    const store = await this.store()
    const key = this.sectionKey(client)
    const grants = store.plugins[key] ?? { permissions: {}, fsScopes: [] }
    grants.permissions[permission] = decision === 'allow-always' ? 'granted' : 'denied'
    store.plugins[key] = grants
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
