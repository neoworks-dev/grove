// Pure keybinding override/custom resolution (no runes) so it can be
// unit-tested. The keymap derives its effective binding list through this:
//   registered defaults ← keybindings.overrides ← keybindings.custom
// Overrides map binding id -> sequence string (project beats user; null
// unbinds). Custom bindings come from both scopes and are appended.

import { parseSequence, type ParsedSequence } from './keySequence'
import type { CustomBinding } from '../../../shared/actions'

export type BindingSource = 'default' | 'user' | 'project' | 'custom-user' | 'custom-project'

export interface DefaultBindingInput {
  id: string
  keys: string
}

export interface ResolvedKeys {
  id: string
  keys: string
  sequence: ParsedSequence
  source: BindingSource
  // For unbound defaults (override null): kept for the keyboard pane listing
  // but excluded from dispatch.
  unbound: boolean
}

export type OverrideMap = Record<string, string | null>

function readOverride(
  id: string,
  userOverrides: OverrideMap,
  projectOverrides: OverrideMap
): { value: string | null; source: BindingSource } | null {
  if (id in projectOverrides) return { value: projectOverrides[id], source: 'project' }
  if (id in userOverrides) return { value: userOverrides[id], source: 'user' }
  return null
}

export function resolveDefaultBindings(
  defaults: DefaultBindingInput[],
  userOverrides: OverrideMap,
  projectOverrides: OverrideMap
): ResolvedKeys[] {
  const resolved: ResolvedKeys[] = []
  for (const binding of defaults) {
    const override = readOverride(binding.id, userOverrides, projectOverrides)
    const entry = resolveOne(binding, override)
    if (entry) resolved.push(entry)
  }
  return resolved
}

function resolveOne(
  binding: DefaultBindingInput,
  override: { value: string | null; source: BindingSource } | null
): ResolvedKeys | null {
  if (override && override.value === null) {
    const sequence = parseSequence(binding.keys)
    if (!sequence) return null
    return { id: binding.id, keys: binding.keys, sequence, source: override.source, unbound: true }
  }
  const keys = override ? (override.value as string) : binding.keys
  const sequence = parseSequence(keys)
  if (!sequence) {
    console.warn(`keymap: ignoring invalid key sequence "${keys}" for "${binding.id}"`)
    return null
  }
  const source = override ? override.source : 'default'
  return { id: binding.id, keys, sequence, source, unbound: false }
}

// Parse the raw settings value for keybindings.custom into usable bindings.
export function readCustomBindings(
  raw: unknown,
  source: 'custom-user' | 'custom-project'
): { binding: CustomBinding; sequence: ParsedSequence; source: BindingSource }[] {
  if (!Array.isArray(raw)) return []
  const result: { binding: CustomBinding; sequence: ParsedSequence; source: BindingSource }[] = []
  for (const value of raw) {
    const binding = value as CustomBinding
    if (!binding || typeof binding.id !== 'string' || typeof binding.keys !== 'string') continue
    if (!binding.action || typeof binding.action !== 'object') continue
    const sequence = parseSequence(binding.keys)
    if (!sequence) continue
    result.push({ binding, sequence, source })
  }
  return result
}

export function readOverrideMap(raw: unknown): OverrideMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const map: OverrideMap = {}
  for (const [id, value] of Object.entries(raw)) {
    if (value === null || typeof value === 'string') map[id] = value
  }
  return map
}

// Stable hash for trust decisions on project-scope actions (djb2).
export function actionHash(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}
