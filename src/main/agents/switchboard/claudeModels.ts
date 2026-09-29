// Every model a Claude Code session can run, and how to reach each one.
//
// Claude Code speaks the Anthropic Messages API, which Anthropic, Bedrock,
// Vertex and any gateway the user brings all serve. switchboard lists what the
// signed-in account is entitled to; the models.dev catalog and the user's own
// endpoints widen that to every model a route reaches, and the variables a
// session starts with are what send it down the route it picked.

import type { ModelInfo } from '@neoworks/harness'
import type {
  CustomEndpoint,
  ModelEntry,
  ModelRoute,
  ProviderCredential
} from '../../../shared/agents'
import type { EndpointsService } from '../../endpoints'
import { loadModelCatalog, type CatalogModel, type CatalogProvider } from '../../modelCatalog'

// Anthropic's own endpoint, which is what an account's own credentials reach.
// Everything the CLI itself lists is grouped under this one in the picker's
// provider → model cascade.
export const PROVIDER = 'anthropic'

// How models.dev names the client of each wire protocol. Claude Code speaks the
// Anthropic Messages API and nothing else, so a provider is runnable here only
// if the catalog puts it on the Anthropic client — or on one of the two
// platforms the CLI has a flag for.
const ANTHROPIC_WIRE_SDK = '@ai-sdk/anthropic'
const BEDROCK_SDK = '@ai-sdk/amazon-bedrock'
const VERTEX_SDK = '@ai-sdk/google-vertex/anthropic'

// Bedrock and Vertex host far more than Claude; only the Claude lines can be
// driven from here, and the catalog names the line in `family`.
const CLAUDE_FAMILY = 'claude'

// The CLI's alias for "whatever is recommended right now". It is a way to reach
// a model rather than a name for one, so it never names an entry.
const RECOMMENDED_ALIAS = 'default'

export interface CredentialSource {
  /** The first of these environment variables that has a value, if any. */
  lookup(variables: string[]): string | null
}

/**
 * The models Claude Code can run: what switchboard listed for the account,
 * widened by the catalog and the user's endpoints.
 */
export async function claudeModels(
  listed: ModelInfo[],
  credentials: CredentialSource,
  endpoints: EndpointsService
): Promise<ModelEntry[]> {
  // The catalog only widens the list, so a failed or empty one costs the extra
  // providers and nothing else.
  const catalog = await loadModelCatalog()
  const custom = await customRoutes(credentials, endpoints)
  return modelsOf(listed, catalog, credentials, custom)
}

/**
 * The user's own endpoints, with whatever each one serves.
 *
 * Asked for here rather than built from a stored list, because a gateway's
 * catalog is its own to change: OpenRouter gains models weekly, and a local
 * proxy serves whatever has been pulled onto the machine that day.
 */
async function customRoutes(
  credentials: CredentialSource,
  endpoints: EndpointsService
): Promise<EndpointModels[]> {
  await endpoints.load()
  return Promise.all(
    endpoints.list().map(async (endpoint) => ({
      endpoint,
      models: await endpoints.modelsOf(endpoint, keyFor(endpoint, credentials))
    }))
  )
}

function keyFor(endpoint: CustomEndpoint, credentials: CredentialSource): string | null {
  if (!endpoint.keyVariable) return null
  return credentials.lookup([endpoint.keyVariable])
}


/**
 * Every model a session can run, with each way of reaching it.
 *
 * Two sources, because neither is complete on its own. The CLI reports the
 * aliases the signed-in account is entitled to — authoritative about the
 * account, silent about every model it is not entitled to and every endpoint it
 * does not sign in to. The catalog reports the models that exist, and who
 * serves them. The same model arrives from both under three or four different
 * ids, so routes are grouped by what the id normalises to.
 */
export function modelsOf(
  models: ModelInfo[],
  catalog: CatalogProvider[],
  credentials: CredentialSource,
  custom: EndpointModels[] = []
): ModelEntry[] {
  const entries = new Map<string, ModelEntry>()
  // How good the name each entry currently carries is, so a better one can
  // replace it without the order routes arrive in deciding anything.
  const ranks = new Map<string, number>()
  for (const keyed of collectRoutes(models, catalog, credentials, custom)) {
    addRoute(entries, ranks, keyed)
  }
  return [...entries.values()].sort(byNativeThenName)
}

interface KeyedRoute {
  key: string
  /** What to call the model this route reaches, if the route knows. */
  label: string | null
  /**
   * How much the label is worth. Bedrock lists the same model as "AU Anthropic
   * Claude Opus 4.6", one row per region; Anthropic calls it "Claude Opus 4.6".
   * The higher rank wins, so a model reads as its maker names it.
   */
  labelRank: number
  route: ModelRoute
}

// Label ranks, lowest first: a platform's own listing name ("AU Anthropic
// Claude Opus 4.6"), then the recommendation alias, which names no model at
// all, then the alias that does name one ("Opus (1M context)"), then
// Anthropic's own name for it.
const RANK_PLATFORM = 0
const RANK_RECOMMENDED_ALIAS = 1
const RANK_NATIVE = 2
const RANK_ANTHROPIC = 3

/** The first of the names a model could go by that is known. */
function firstLabel(label: string | null, routeLabel: string | undefined, key: string): string {
  if (label !== null) return label
  if (routeLabel !== undefined) return routeLabel
  return key
}

/** One of the user's endpoints, with the models it turned out to serve. */
export interface EndpointModels {
  endpoint: CustomEndpoint
  models: string[]
}

function collectRoutes(
  models: ModelInfo[],
  catalog: CatalogProvider[],
  credentials: CredentialSource,
  custom: EndpointModels[]
): KeyedRoute[] {
  // The CLI's own rows first: a native route displaces a derived one, and the
  // model the account is entitled to is the one worth defaulting to.
  const routes = models.map(routeFromCli)
  for (const provider of catalog) {
    const credential = credentialState(provider, credentials)
    for (const model of runnableModels(provider)) {
      routes.push(routeFromCatalog(model, provider, credential))
    }
  }
  for (const entry of custom) {
    for (const id of entry.models) {
      routes.push(routeFromEndpoint(id, entry.endpoint, credentials))
    }
  }
  return routes
}

/**
 * A model on an endpoint the user brought.
 *
 * Its ids are the gateway's own — `moonshotai/kimi-k2` on OpenRouter, whatever
 * a local proxy calls what it has loaded — so they are filed under the last
 * segment: the same model reached through three gateways is one row, and the
 * route says which gateway.
 */
function routeFromEndpoint(
  id: string,
  endpoint: CustomEndpoint,
  credentials: CredentialSource
): KeyedRoute {
  return {
    key: normalizeModelId(id.split('/').pop() ?? id),
    label: null,
    labelRank: RANK_PLATFORM,
    route: {
      provider: endpoint.id,
      providerLabel: endpoint.label,
      id,
      endpoint: endpoint.baseUrl,
      credential: endpointCredential(endpoint, credentials)
    }
  }
}

/** An endpoint with no key named needs none — a local proxy usually does not. */
function endpointCredential(
  endpoint: CustomEndpoint,
  credentials: CredentialSource
): ProviderCredential | undefined {
  if (!endpoint.keyVariable) return undefined
  return {
    kind: 'key',
    env: [endpoint.keyVariable],
    present: credentials.lookup([endpoint.keyVariable]) !== null
  }
}

/**
 * A row the CLI listed. Most are aliases (`default`, `opus[1m]`) rather than
 * wire model ids; normalising the id is what groups `opus[1m]` with the model
 * the catalog names.
 */
function routeFromCli(model: ModelInfo): KeyedRoute {
  return {
    key: normalizeModelId(model.id),
    // An alias mostly names the model well enough to stand in until the catalog
    // offers Anthropic's own name — except `default`, which names only the fact
    // that the CLI recommends it, and would still read that way next release.
    label: model.name,
    labelRank: model.id === RECOMMENDED_ALIAS ? RANK_RECOMMENDED_ALIAS : RANK_NATIVE,
    route: {
      provider: PROVIDER,
      providerLabel: 'Anthropic',
      id: model.id,
      label: model.name,
      native: true
    }
  }
}

function routeFromCatalog(
  model: CatalogModel,
  provider: CatalogProvider,
  credential: ProviderCredential | undefined
): KeyedRoute {
  return {
    key: normalizeModelId(model.id),
    label: model.name,
    labelRank: provider.id === PROVIDER ? RANK_ANTHROPIC : RANK_PLATFORM,
    route: {
      provider: provider.id,
      providerLabel: provider.name,
      id: model.id,
      endpoint: provider.api ?? undefined,
      credential,
      contextWindow: model.contextWindow ?? undefined,
      pricing: model.pricing ?? undefined
    }
  }
}

/**
 * File one route under its model.
 *
 * Every route the CLI itself listed is kept, even when two of them reach the
 * same model: `default` and `opus[1m]` both resolve to Claude Opus 5 with a 1M
 * window, and they are two things a person can pick — one follows whatever the
 * CLI recommends, the other names the model. Dropping either loses a choice the
 * account has.
 *
 * What is dropped is the catalog's own copy of a route the CLI already covers:
 * the same endpoint under the wire id, which would list Anthropic twice.
 */
function addRoute(
  entries: Map<string, ModelEntry>,
  ranks: Map<string, number>,
  keyed: KeyedRoute
): void {
  const { key, label, labelRank, route } = keyed
  const entry = entries.get(key)
  if (!entry) {
    entries.set(key, { key, label: firstLabel(label, route.label, key), routes: [route] })
    ranks.set(key, label ? labelRank : -1)
    return
  }
  if (label && isBetterLabel(entry.label, label, labelRank, ranks.get(key) ?? -1)) {
    entry.label = label
    ranks.set(key, labelRank)
  }

  const sameRoute = entry.routes.findIndex(
    (candidate) => candidate.provider === route.provider && candidate.id === route.id
  )
  if (sameRoute !== -1) {
    entry.routes[sameRoute] = mergeRoutes(entry.routes[sameRoute], route)
    return
  }

  // A catalog row for a provider the CLI already reaches this model through is
  // that same route under another name; the blessed one keeps the slot, and
  // learns the price and context window the catalog knows.
  if (!route.native) {
    const native = entry.routes.findIndex(
      (candidate) => candidate.native && candidate.provider === route.provider
    )
    if (native !== -1) {
      entry.routes[native] = mergeRoutes(entry.routes[native], route)
      return
    }
  }

  entry.routes.push(route)
}

/**
 * Whether a name should replace the one an entry carries.
 *
 * Rank decides it, and where two sources rank the same the shorter name wins:
 * the catalog lists a moving id and the snapshot it points at as "Claude Haiku
 * 4.5 (latest)" and "Claude Haiku 4.5", and they are the same model.
 */
function isBetterLabel(
  current: string,
  candidate: string,
  candidateRank: number,
  currentRank: number
): boolean {
  if (candidateRank > currentRank) return true
  if (candidateRank < currentRank) return false
  return candidate.length < current.length
}

/** The blessed route, told whatever the other one knew about the model. */
function mergeRoutes(left: ModelRoute, right: ModelRoute): ModelRoute {
  const [kept, other] = left.native ? [left, right] : [right, left]
  return {
    ...kept,
    contextWindow: kept.contextWindow ?? other.contextWindow,
    pricing: kept.pricing ?? other.pricing,
    credential: kept.credential ?? other.credential
  }
}

/**
 * The id a provider uses, as the model behind it.
 *
 * Platforms spell the same model their own way — Bedrock prefixes a region and
 * `anthropic.` and suffixes a version, Vertex suffixes `@default` — and none of
 * that is part of the model. Variants that genuinely differ, `[1m]` above all,
 * survive: they are a different model to run.
 */
export function normalizeModelId(id: string): string {
  return (
    id
      .replace(/^[a-z0-9-]+\.anthropic\./, '')
      .replace(/^anthropic\./, '')
      .replace(/@.*$/, '')
      .replace(/-v\d+(?::\d+)?$/, '')
      // A dated snapshot is the same model as the moving id that points at it:
      // `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are one row, not two.
      .replace(/-\d{8}$/, '')
      .toLowerCase()
  )
}

/** Entries the account can run come first; the rest read alphabetically. */
function byNativeThenName(left: ModelEntry, right: ModelEntry): number {
  const leftNative = left.routes.some((route) => route.native)
  const rightNative = right.routes.some((route) => route.native)
  if (leftNative !== rightNative) return leftNative ? -1 : 1
  return left.label.localeCompare(right.label)
}

/** The models of one catalog provider that Claude Code can actually drive. */
function runnableModels(provider: CatalogProvider): CatalogModel[] {
  if (provider.sdk === ANTHROPIC_WIRE_SDK) return provider.models
  if (provider.sdk !== BEDROCK_SDK && provider.sdk !== VERTEX_SDK) return []
  return provider.models.filter((model) => {
    const family = model.family ?? model.id
    return family.toLowerCase().includes(CLAUDE_FAMILY)
  })
}

/**
 * What a route asks for before it can be taken.
 *
 * Anthropic's own endpoint asks for nothing: the CLI signs itself in, and the
 * account behind that sign-in is exactly what makes a route native. Bedrock and
 * Vertex sign in through their own cloud tooling — a profile, an instance role,
 * application-default credentials — which grove cannot see, so they are
 * reported as a platform sign-in instead of a key to be typed. Everything else
 * is one key, which grove can hold.
 */
function credentialState(
  provider: CatalogProvider,
  credentials: CredentialSource
): ProviderCredential | undefined {
  if (provider.id === PROVIDER) return undefined
  if (provider.env.length === 0) return undefined
  if (provider.sdk === BEDROCK_SDK || provider.sdk === VERTEX_SDK) {
    return { kind: 'platform', env: provider.env, present: false }
  }
  return {
    kind: 'key',
    env: provider.env,
    present: credentials.lookup(provider.env) !== null
  }
}

/**
 * The environment a session runs the CLI under.
 *
 * Anthropic's own endpoint needs nothing: the CLI already knows how the account
 * signs in. Every other provider is reached the way Claude Code documents it —
 * `ANTHROPIC_BASE_URL` at the endpoint, the provider's own key as
 * `ANTHROPIC_AUTH_TOKEN`, or the platform flag for Bedrock and Vertex.
 *
 * The SDK replaces the child's environment with whatever is returned here, so
 * this starts from grove's own.
 */
export async function sessionEnvironment(
  provider: string | null,
  credentials: CredentialSource,
  endpoints: EndpointsService
): Promise<Record<string, string | undefined> | undefined> {
  if (!provider || provider === PROVIDER) return undefined

  await endpoints.load()
  const own = endpoints.find(provider)
  if (own) return { ...process.env, ...endpointVariables(own, credentials) }

  const entry = (await loadModelCatalog()).find((candidate) => candidate.id === provider)
  if (!entry) return undefined
  return { ...process.env, ...providerVariables(entry, credentials) }
}

/** What running against one of the user's own endpoints takes. */
export function endpointVariables(
  endpoint: CustomEndpoint,
  credentials: CredentialSource
): Record<string, string | undefined> {
  const variables: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    // Not Anthropic on the other end, so grove's own key must not travel there.
    ANTHROPIC_API_KEY: undefined
  }
  if (!endpoint.keyVariable) return variables
  const key = credentials.lookup([endpoint.keyVariable])
  if (key) variables.ANTHROPIC_AUTH_TOKEN = key
  return variables
}

export function providerVariables(
  provider: CatalogProvider,
  credentials: CredentialSource
): Record<string, string | undefined> {
  if (provider.sdk === BEDROCK_SDK) return { CLAUDE_CODE_USE_BEDROCK: '1' }
  if (provider.sdk === VERTEX_SDK) return { CLAUDE_CODE_USE_VERTEX: '1' }

  const variables: Record<string, string | undefined> = {}
  if (provider.api) variables.ANTHROPIC_BASE_URL = provider.api
  const token = credentials.lookup(provider.env)
  if (token) variables.ANTHROPIC_AUTH_TOKEN = token
  // The session is no longer talking to Anthropic, so the Anthropic credentials
  // in grove's own environment must not travel to whoever is on the other end.
  variables.ANTHROPIC_API_KEY = undefined
  return variables
}

/** The CLI lists its recommended model first, which is the one to start on. */
export function defaultModelOf(models: ModelInfo[]): { provider: string; model: string } | null {
  const first = models[0]
  if (!first) return null
  return { provider: PROVIDER, model: first.id }
}
