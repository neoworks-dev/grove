// External app pairing: identity + token store for socket clients
// (external-apps.json in userData). api.hello without a valid token raises a
// pairing prompt in the renderer; approval mints a 32-byte bearer token whose
// sha256 hash is persisted. Runtime allow/deny decisions for app scopes live
// in the shared grant store under 'app:<id>' — this store only holds who the
// app is, its token, and the scopes granted at pairing.

import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import {
  PLUGIN_ID_PATTERN,
  PLUGIN_PERMISSIONS,
  GROVE_API_VERSION,
  type HelloParams,
  type HelloResult,
  type PluginPermission
} from '../../../shared/plugins'
import type { ClientRecord } from '../clients'
import { ApiError } from '../registry'

export interface AppPairingRequest {
  id: string
  appId: string
  appName: string
  requestedScopes: PluginPermission[]
}

export interface AppRecord {
  appId: string
  name: string
  tokenHash: string
  grantedScopes: PluginPermission[]
  createdAt: string
  lastSeenAt: string
}

interface AppStoreFile {
  apps: Record<string, AppRecord>
}

const PAIRING_TIMEOUT_MS = 60_000

interface PairingEvents {
  onPairingRequest: (request: AppPairingRequest) => void
}

interface PairingOptions {
  // Overridable for tests; defaults to <userData>/external-apps.json.
  storePath?: string
  pairingTimeoutMs?: number
}

export class AppPairing {
  private events: PairingEvents
  private storeFilePath: string | null
  private pairingTimeoutMs: number
  private cache: AppStoreFile | null = null
  private pending = new Map<string, (approved: boolean) => void>()
  // One pairing dialog per app at a time; concurrent hellos share it.
  private inFlight = new Map<string, Promise<boolean>>()
  private requestCounter = 0

  constructor(events: PairingEvents, options: PairingOptions = {}) {
    this.events = events
    this.storeFilePath = options.storePath ?? null
    this.pairingTimeoutMs = options.pairingTimeoutMs ?? PAIRING_TIMEOUT_MS
  }

  private async storePath(): Promise<string> {
    if (this.storeFilePath) return this.storeFilePath
    const { app } = await import('electron')
    this.storeFilePath = join(app.getPath('userData'), 'external-apps.json')
    return this.storeFilePath
  }

  private async store(): Promise<AppStoreFile> {
    if (this.cache) return this.cache
    let loaded: AppStoreFile
    try {
      loaded = { apps: {}, ...JSON.parse(await readFile(await this.storePath(), 'utf8')) }
    } catch {
      loaded = { apps: {} }
    }
    this.cache = loaded
    return loaded
  }

  private async save(): Promise<void> {
    if (!this.cache) return
    const path = await this.storePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(this.cache, null, 2), 'utf8')
  }

  // Resolves the connection's identity. Valid token → existing grant rides;
  // otherwise (first contact, bad token, or scope escalation) the user must
  // approve, and a fresh token is returned for the client to persist.
  async hello(params: HelloParams): Promise<{ client: ClientRecord; result: HelloResult }> {
    validateHello(params)
    const store = await this.store()
    const existing = store.apps[params.appId]
    const tokenValid =
      existing !== undefined &&
      params.token !== undefined &&
      hashMatches(existing.tokenHash, params.token)
    const escalating =
      existing !== undefined &&
      params.requestedScopes.some((scope) => !existing.grantedScopes.includes(scope))

    if (tokenValid && !escalating) {
      existing.lastSeenAt = new Date().toISOString()
      await this.save()
      return {
        client: this.clientFor(existing),
        result: { apiVersion: GROVE_API_VERSION, grantedScopes: existing.grantedScopes }
      }
    }

    const approved = await this.promptPairing(params)
    if (!approved) {
      throw new ApiError(`pairing denied for ${params.appId}`, 'unauthenticated')
    }
    const token = randomBytes(32).toString('base64url')
    const now = new Date().toISOString()
    const grantedScopes = mergeScopes(existing?.grantedScopes ?? [], params.requestedScopes)
    const record: AppRecord = {
      appId: params.appId,
      name: params.name,
      tokenHash: hashToken(token),
      grantedScopes,
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now
    }
    store.apps[params.appId] = record
    await this.save()
    return {
      client: this.clientFor(record),
      result: { apiVersion: GROVE_API_VERSION, grantedScopes, token }
    }
  }

  private clientFor(record: AppRecord): ClientRecord {
    return {
      key: `app:${record.appId}`,
      kind: 'app',
      id: record.appId,
      name: record.name,
      source: 'external',
      declaredScopes: record.grantedScopes
    }
  }

  private promptPairing(params: HelloParams): Promise<boolean> {
    const existing = this.inFlight.get(params.appId)
    if (existing) return existing
    const promise = this.promptOnce(params).finally(() => {
      this.inFlight.delete(params.appId)
    })
    this.inFlight.set(params.appId, promise)
    return promise
  }

  private promptOnce(params: HelloParams): Promise<boolean> {
    this.requestCounter += 1
    const id = `app-pairing-${this.requestCounter}`
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(false)
      }, this.pairingTimeoutMs)
      this.pending.set(id, (approved) => {
        clearTimeout(timer)
        resolve(approved)
      })
      this.events.onPairingRequest({
        id,
        appId: params.appId,
        appName: params.name,
        requestedScopes: params.requestedScopes
      })
    })
  }

  respondPairing(id: string, approved: boolean): void {
    const resolver = this.pending.get(id)
    if (!resolver) return
    this.pending.delete(id)
    resolver(approved)
  }

  async list(): Promise<Omit<AppRecord, 'tokenHash'>[]> {
    const store = await this.store()
    return Object.values(store.apps).map((record) => ({
      appId: record.appId,
      name: record.name,
      grantedScopes: record.grantedScopes,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt
    }))
  }

  // Unpair: the token stops working immediately; the caller is responsible
  // for dropping live connections.
  async revoke(appId: string): Promise<void> {
    const store = await this.store()
    if (!store.apps[appId]) return
    delete store.apps[appId]
    await this.save()
  }
}

function validateHello(params: HelloParams): void {
  if (typeof params.appId !== 'string' || !PLUGIN_ID_PATTERN.test(params.appId)) {
    throw new ApiError('hello: appId must match the plugin id grammar', 'invalid')
  }
  if (typeof params.name !== 'string' || params.name.length === 0) {
    throw new ApiError('hello: name must be a non-empty string', 'invalid')
  }
  if (!Array.isArray(params.requestedScopes)) {
    throw new ApiError('hello: requestedScopes must be an array', 'invalid')
  }
  for (const scope of params.requestedScopes) {
    if (!PLUGIN_PERMISSIONS.includes(scope)) {
      throw new ApiError(`hello: unknown scope "${String(scope)}"`, 'invalid')
    }
  }
}

function mergeScopes(
  existing: PluginPermission[],
  requested: PluginPermission[]
): PluginPermission[] {
  const merged = new Set([...existing, ...requested])
  return [...merged]
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashMatches(storedHash: string, token: string): boolean {
  const presented = Buffer.from(hashToken(token), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  if (presented.length !== stored.length) return false
  return timingSafeEqual(presented, stored)
}
