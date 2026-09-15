// The public model catalog, from models.dev.
//
// A harness can only enumerate what its own runtime admits to: Claude Code lists
// the aliases the signed-in account is entitled to, which is never the set of
// models it can actually run — it takes any model name on `--model`, and any
// Anthropic-wire endpoint through `ANTHROPIC_BASE_URL`. This catalog is where
// the rest of that set comes from, so no list of model ids has to be kept by
// hand here.
//
// The fetch is cached on disk and refreshed a day at a time. Nothing here is on
// a path that decides whether a harness is available: a cold start with no
// network simply offers what the harness itself reported.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelPricing } from '../shared/agents'

const CATALOG_URL = 'https://models.dev/api.json'
const CACHE_FILE = 'model-catalog.json'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000

export interface CatalogModel {
  id: string
  name: string
  /** The model line, as the catalog groups it: `claude-opus`, `glm`, … */
  family: string | null
  contextWindow: number | null
  maxOutput: number | null
  pricing: ModelPricing | null
}

export interface CatalogProvider {
  id: string
  name: string
  /**
   * The npm client models.dev names for the provider, which is how its wire
   * protocol is identified: everything on `@ai-sdk/anthropic` speaks the
   * Anthropic Messages API and can therefore be driven by Claude Code.
   */
  sdk: string
  /** Where an Anthropic-wire client points; null for Anthropic's own endpoint. */
  api: string | null
  /** The environment variables the provider's credential is read from. */
  env: string[]
  models: CatalogModel[]
}

interface CachedCatalog {
  fetchedAt: number
  providers: CatalogProvider[]
}

let inflight: Promise<CatalogProvider[]> | null = null
let loaded: CachedCatalog | null = null

/**
 * The catalog, from memory, then disk, then the network.
 *
 * Never throws: a provider list is an enrichment, and every caller has to work
 * without one anyway (offline, first run, models.dev down).
 */
export async function loadModelCatalog(): Promise<CatalogProvider[]> {
  if (loaded && !isStale(loaded)) return loaded.providers
  if (!inflight) {
    inflight = resolveCatalog().finally(() => {
      inflight = null
    })
  }
  return inflight
}

/** Re-read the catalog from the network, ignoring how fresh the cache is. */
export async function refreshModelCatalog(): Promise<CatalogProvider[]> {
  const fetched = await fetchCatalog()
  if (!fetched) return loadModelCatalog()
  loaded = { fetchedAt: Date.now(), providers: fetched }
  await writeCache(loaded)
  return fetched
}

/** The providers speaking one wire protocol, named by their npm client. */
export function providersUsing(providers: CatalogProvider[], sdks: string[]): CatalogProvider[] {
  return providers.filter((provider) => sdks.includes(provider.sdk))
}

async function resolveCatalog(): Promise<CatalogProvider[]> {
  const cached = await readCache()
  if (cached && !isStale(cached)) {
    loaded = cached
    return cached.providers
  }

  const fetched = await fetchCatalog()
  if (fetched) {
    loaded = { fetchedAt: Date.now(), providers: fetched }
    await writeCache(loaded)
    return fetched
  }

  // Stale beats empty: a day-old price is still a better answer than no model.
  if (cached) {
    loaded = cached
    return cached.providers
  }
  return []
}

function isStale(catalog: CachedCatalog): boolean {
  return Date.now() - catalog.fetchedAt > MAX_AGE_MS
}

async function fetchCatalog(): Promise<CatalogProvider[] | null> {
  try {
    const response = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!response.ok) return null
    return parseCatalog(await response.json())
  } catch {
    return null
  }
}

/**
 * models.dev's payload, as grove's shape.
 *
 * Kept separate from the fetch so the parsing is testable and so an entry the
 * catalog grows a new field for still reads.
 */
export function parseCatalog(payload: unknown): CatalogProvider[] {
  if (!isRecord(payload)) return []
  const providers: CatalogProvider[] = []
  for (const [id, entry] of Object.entries(payload)) {
    const provider = parseProvider(id, entry)
    if (provider) providers.push(provider)
  }
  return providers
}

function parseProvider(id: string, entry: unknown): CatalogProvider | null {
  if (!isRecord(entry)) return null
  const sdk = stringOf(entry.npm)
  if (!sdk) return null
  return {
    id,
    name: stringOf(entry.name) ?? id,
    sdk,
    api: stringOf(entry.api),
    env: stringList(entry.env),
    models: parseModels(entry.models)
  }
}

function parseModels(models: unknown): CatalogModel[] {
  if (!isRecord(models)) return []
  const parsed: CatalogModel[] = []
  for (const [id, entry] of Object.entries(models)) {
    if (!isRecord(entry)) continue
    parsed.push({
      id: stringOf(entry.id) ?? id,
      name: stringOf(entry.name) ?? id,
      family: stringOf(entry.family),
      contextWindow: limitOf(entry.limit, 'context'),
      maxOutput: limitOf(entry.limit, 'output'),
      pricing: pricingOf(entry.cost)
    })
  }
  return parsed
}

function pricingOf(cost: unknown): ModelPricing | null {
  if (!isRecord(cost)) return null
  const input = numberOf(cost.input)
  const output = numberOf(cost.output)
  if (input === null || output === null) return null
  return {
    input,
    output,
    cacheRead: numberOf(cost.cache_read) ?? 0,
    cacheWrite: numberOf(cost.cache_write) ?? 0
  }
}

function limitOf(limit: unknown, field: 'context' | 'output'): number | null {
  if (!isRecord(limit)) return null
  return numberOf(limit[field])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  return value
}

function numberOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

async function cachePath(): Promise<string> {
  const { app } = await import('electron')
  return join(app.getPath('userData'), CACHE_FILE)
}

async function readCache(): Promise<CachedCatalog | null> {
  try {
    const path = await cachePath()
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(parsed)) return null
    const fetchedAt = numberOf(parsed.fetchedAt)
    if (fetchedAt === null || !Array.isArray(parsed.providers)) return null
    return { fetchedAt, providers: parsed.providers as CatalogProvider[] }
  } catch {
    return null
  }
}

async function writeCache(catalog: CachedCatalog): Promise<void> {
  try {
    const path = await cachePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(catalog), 'utf8')
  } catch {
    // A cache that cannot be written costs a refetch, and nothing else.
  }
}
