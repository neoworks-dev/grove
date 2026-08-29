// Provider/model selection helpers for task-specific agent sessions. Model ids
// are discovered from nib and remain open strings; the persisted JSON tuple
// avoids assuming either side excludes separators such as ':' or '/'.

import type { ProviderModels } from './types'

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

export function discoveredModelOptions(providers: ProviderModels[]): ModelOption[] {
  return providers.flatMap((entry) =>
    entry.models.map((model) => {
      const selection = { provider: entry.provider, model: model.id }
      return {
        ...selection,
        key: encodeModelSelection(selection),
        label: `${entry.provider} / ${model.id}`
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
