// Endpoints the user brings themselves.
//
// The catalog knows who sells which model, but not who the user has an account
// with: an OpenRouter key, a LiteLLM container on the LAN, llama.cpp behind a
// translating proxy. Any of them is a base URL that speaks the Anthropic
// Messages API, which is the only thing Claude Code needs, so grove stores them
// as routes of its own and offers whatever they serve.
//
// The key never lives here — only the name of the variable it is stored under,
// so the file can be read, copied and diffed without leaking anything.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { CustomEndpoint } from '../shared/agents'

const ENDPOINTS_FILE = 'endpoints.json'
const DISCOVERY_TIMEOUT_MS = 10_000

/** How long a discovered model list is trusted before it is fetched again. */
const DISCOVERY_MAX_AGE_MS = 60 * 60 * 1000

interface Discovered {
  fetchedAt: number
  models: string[]
}

export class EndpointsService {
  private endpoints: CustomEndpoint[] = []
  private discovered = new Map<string, Discovered>()
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    this.endpoints = await this.read()
  }

  list(): CustomEndpoint[] {
    return this.endpoints
  }

  find(id: string): CustomEndpoint | undefined {
    return this.endpoints.find((endpoint) => endpoint.id === id)
  }

  /** Add or replace an endpoint, keyed by its id. */
  async save(endpoint: CustomEndpoint): Promise<CustomEndpoint[]> {
    await this.load()
    const without = this.endpoints.filter((candidate) => candidate.id !== endpoint.id)
    this.endpoints = [...without, endpoint]
    this.discovered.delete(endpoint.id)
    await this.write()
    return this.endpoints
  }

  async remove(id: string): Promise<CustomEndpoint[]> {
    await this.load()
    this.endpoints = this.endpoints.filter((endpoint) => endpoint.id !== id)
    this.discovered.delete(id)
    await this.write()
    return this.endpoints
  }

  /**
   * The models an endpoint says it serves, plus whatever the user listed.
   *
   * Most of these gateways answer `GET /models` in OpenAI's shape even when
   * their chat surface is Anthropic's — OpenRouter, LiteLLM and Ollama all do —
   * so the list is asked for rather than typed. One that does not answer leaves
   * the user's own ids, which is why both exist.
   */
  async modelsOf(endpoint: CustomEndpoint, key: string | null): Promise<string[]> {
    const listed = endpoint.models ?? []
    const cached = this.discovered.get(endpoint.id)
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_MAX_AGE_MS) {
      return merge(listed, cached.models)
    }

    const fetched = await discoverModels(endpoint.baseUrl, key)
    if (fetched === null) return listed
    this.discovered.set(endpoint.id, { fetchedAt: Date.now(), models: fetched })
    return merge(listed, fetched)
  }

  private async read(): Promise<CustomEndpoint[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(endpointsPath(), 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isEndpoint)
    } catch {
      return []
    }
  }

  private async write(): Promise<void> {
    const path = endpointsPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(this.endpoints, null, 2) + '\n', 'utf8')
  }
}

/**
 * Ask a gateway what it serves.
 *
 * Returns null when it will not say, which is different from saying it serves
 * nothing: the first leaves the user's own list alone, the second would empty
 * it.
 */
export async function discoverModels(
  baseUrl: string,
  key: string | null
): Promise<string[] | null> {
  try {
    const response = await fetch(modelsUrl(baseUrl), {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    })
    if (!response.ok) return null
    return modelIdsOf(await response.json())
  } catch {
    return null
  }
}

/** `GET /models` beside the chat endpoint, however the base URL was written. */
function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`
}

/**
 * Model ids out of a listing, in either shape these gateways answer with:
 * OpenAI's `{ data: [{ id }] }` or a bare array of the same objects.
 */
export function modelIdsOf(payload: unknown): string[] | null {
  const rows = rowsOf(payload)
  if (!rows) return null
  const ids = rows
    .map((row) => (isRecord(row) && typeof row.id === 'string' ? row.id : null))
    .filter((id): id is string => id !== null)
  if (ids.length === 0) return null
  return ids
}

function rowsOf(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data
  if (isRecord(payload) && Array.isArray(payload.models)) return payload.models
  return null
}

function merge(listed: string[], discovered: string[]): string[] {
  return [...new Set([...listed, ...discovered])]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEndpoint(value: unknown): value is CustomEndpoint {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.label !== 'string') return false
  return typeof value.baseUrl === 'string' && value.baseUrl !== ''
}

function endpointsPath(): string {
  return join(app.getPath('userData'), ENDPOINTS_FILE)
}
