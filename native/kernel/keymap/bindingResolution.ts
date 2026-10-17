// Pure keybinding override resolution, ported from Grove's bindingResolution. The keymap
// derives its effective binding list through this: registered defaults, then an override
// map from binding id to a sequence string, where null unbinds the default.

import { parseSequence, type ParsedSequence } from './keySequence'

export interface DefaultBindingInput {
  id: string
  keys: string
}

export interface ResolvedKeys {
  id: string
  keys: string
  sequence: ParsedSequence
  // For unbound defaults (override null): kept for listings but excluded from dispatch.
  unbound: boolean
}

export type OverrideMap = Record<string, string | null>

/**
 * Each default binding with its override applied. A binding whose keys (or override) do
 * not parse is left out, and its id reported through `onInvalid` so the caller can log it.
 */
export function resolveDefaultBindings(
  defaults: DefaultBindingInput[],
  overrides: OverrideMap,
  onInvalid: (id: string, keys: string) => void = () => {}
): ResolvedKeys[] {
  const resolved: ResolvedKeys[] = []
  for (const binding of defaults) {
    const entry = resolveOne(binding, overrides, onInvalid)
    if (entry) resolved.push(entry)
  }
  return resolved
}

function resolveOne(
  binding: DefaultBindingInput,
  overrides: OverrideMap,
  onInvalid: (id: string, keys: string) => void
): ResolvedKeys | null {
  const overridden = binding.id in overrides
  const override = overrides[binding.id]
  if (overridden && override === null) {
    const sequence = parseSequence(binding.keys)
    if (!sequence) return null
    return { id: binding.id, keys: binding.keys, sequence, unbound: true }
  }
  let keys = binding.keys
  if (overridden) keys = override as string
  const sequence = parseSequence(keys)
  if (!sequence) {
    onInvalid(binding.id, keys)
    return null
  }
  return { id: binding.id, keys, sequence, unbound: false }
}

/** Reads a hand-written override map, keeping only string and null values. */
export function readOverrideMap(raw: unknown): OverrideMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const map: OverrideMap = {}
  for (const [id, value] of Object.entries(raw)) {
    if (value === null || typeof value === 'string') map[id] = value
  }
  return map
}
