// Picking a model, and the route that reaches it.
//
// A session is started on a provider and a model id, which is exactly one route
// of one model. The picker works the other way round — the model is what a
// person means, the route is which of several sellers serves it — so everything
// here translates between the two. Ids stay open strings; the persisted JSON
// tuple avoids assuming either side excludes separators such as ':' or '/'.

import type { ModelEntry, ModelRoute } from './types'

export interface ModelSelection {
  provider: string
  model: string
}

export interface ModelOption extends ModelSelection {
  key: string
  label: string
}

/** A model together with the one route a selection picked out of it. */
export interface ResolvedModel {
  entry: ModelEntry
  route: ModelRoute
}

export function encodeModelSelection(selection: ModelSelection): string {
  return JSON.stringify([selection.provider, selection.model])
}

export function decodeModelSelection(value: unknown): ModelSelection | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [provider, model] = parsed
    if (typeof provider !== 'string' || provider === '') return null
    if (typeof model !== 'string' || model === '') return null
    return { provider, model }
  } catch {
    return null
  }
}

export function selectionOf(route: ModelRoute): ModelSelection {
  return { provider: route.provider, model: route.id }
}

/** The model and route a session is on, when the harness still lists them. */
export function findRoute(
  models: ModelEntry[],
  selection: ModelSelection | null
): ResolvedModel | null {
  if (!selection) return null
  for (const entry of models) {
    const route = entry.routes.find(
      (candidate) => candidate.provider === selection.provider && candidate.id === selection.model
    )
    if (route) return { entry, route }
  }
  return null
}

/** Whether a route can be taken right now, or is waiting for a credential. */
export function routeReady(route: ModelRoute): boolean {
  if (!route.credential) return true
  return route.credential.present
}

/**
 * The route to start on when a model is picked rather than a route.
 *
 * What the harness itself blessed comes first, then anything with a credential;
 * a route that needs a key is only chosen when it is the only one there is.
 */
export function preferredRoute(entry: ModelEntry): ModelRoute | null {
  const native = entry.routes.find((route) => route.native && routeReady(route))
  if (native) return native
  const ready = entry.routes.find(routeReady)
  if (ready) return ready
  return entry.routes[0] ?? null
}

/** How a route names itself: its own label when it has one, else its model id. */
export function routeLabel(route: ModelRoute): string {
  if (route.label) return route.label
  return route.id
}

/** Every route of every model, flattened for a one-line enum such as a setting. */
export function discoveredModelOptions(models: ModelEntry[]): ModelOption[] {
  return models.flatMap((entry) =>
    entry.routes.map((route) => {
      const selection = selectionOf(route)
      return {
        ...selection,
        key: encodeModelSelection(selection),
        label: `${route.provider} / ${entry.label} · ${route.id}`
      }
    })
  )
}

export function resolveModelSelection(
  configured: unknown,
  defaults: ModelSelection | null,
  models: ModelEntry[]
): ModelSelection | null {
  const selected = decodeModelSelection(configured)
  if (findRoute(models, selected)) return selected
  if (findRoute(models, defaults)) return defaults

  const first = models[0]
  if (!first) return null
  const route = preferredRoute(first)
  if (!route) return null
  return selectionOf(route)
}

/**
 * Whether a model answers to what was typed.
 *
 * The name is what people search by, but the id is what they paste — and a
 * route's own id differs from the model's, so a search for `us.anthropic.…`
 * has to find the model it belongs to.
 */
export function matchesQuery(entry: ModelEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  if (entry.label.toLowerCase().includes(needle)) return true
  if (entry.key.includes(needle)) return true
  return entry.routes.some((route) => {
    if (route.id.toLowerCase().includes(needle)) return true
    if (route.provider.toLowerCase().includes(needle)) return true
    return routeLabel(route).toLowerCase().includes(needle)
  })
}
