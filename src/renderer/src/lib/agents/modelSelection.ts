// Provider/model selection helpers for task-specific agent sessions. Model ids
// are discovered from the harness and remain open strings; the persisted JSON
// tuple avoids assuming either side excludes separators such as ':' or '/'.

import type { ModelInfo, ProviderModels } from './types'

export interface ModelSelection {
  provider: string
  model: string
}

export interface ModelOption extends ModelSelection {
  key: string
  label: string
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

/**
 * What the model is called, the way its harness writes it for people.
 *
 * Falls back to the id, which is all a harness that only lists ids can offer.
 */
export function modelName(model: ModelInfo): string {
  if (model.label) return model.label
  return model.id
}

/**
 * The model id worth showing: the wire model an alias resolves to, when the
 * harness said so, and otherwise the id itself.
 *
 * Claude Code lists aliases (`default`, `opus[1m]`), so without this the picker
 * can only say "Default (recommended)" and never which model that is.
 */
export function modelWireId(model: ModelInfo): string {
  if (model.resolvedId) return model.resolvedId
  return model.id
}

/** Name and id together, for a single-line slot such as a settings dropdown. */
export function describeModel(model: ModelInfo): string {
  const name = modelName(model)
  const id = modelWireId(model)
  if (name === id) return name
  return `${name} · ${id}`
}

export function discoveredModelOptions(providers: ProviderModels[]): ModelOption[] {
  return providers.flatMap((entry) =>
    entry.models.map((model) => {
      const selection = { provider: entry.provider, model: model.id }
      return {
        ...selection,
        key: encodeModelSelection(selection),
        label: `${entry.provider} / ${describeModel(model)}`
      }
    })
  )
}

export function resolveModelSelection(
  configured: unknown,
  defaults: ModelSelection | null,
  providers: ProviderModels[]
): ModelSelection | null {
  const options = discoveredModelOptions(providers)
  const selected = decodeModelSelection(configured)
  if (selected && options.some((option) => option.key === encodeModelSelection(selected))) {
    return selected
  }
  if (defaults) {
    const defaultKey = encodeModelSelection(defaults)
    const found = options.find((option) => option.key === defaultKey)
    if (found) return { provider: found.provider, model: found.model }
  }
  const first = options[0]
  return first ? { provider: first.provider, model: first.model } : null
}
