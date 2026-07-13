// Converts nvim keymaps (nvim_get_keymap / nvim_buf_get_keymap) into grove
// keybindings so the which-key overlay lists nvim's leader mappings next to
// grove's own. Only leader-prefixed maps (mapleader = space) are surfaced:
// grove owns the space leader and forwards completed sequences back to nvim, so
// these stay executable. nvim's bare motion keys (g, z, …) are deliberately
// excluded — registering them would let grove swallow keys nvim needs to edit.

import type { KeyBinding } from './keymap.svelte'
import { normalizeSequence } from './keySequence'

export interface NvimMapping {
  lhs: string
  rhs?: string
  desc?: string | null
}

// nvim <> key names → grove named keys (see keySequence NAMED_KEYS).
const SPECIAL_KEYS: Record<string, string> = {
  space: 'space',
  cr: 'enter',
  return: 'enter',
  enter: 'enter',
  esc: 'escape',
  tab: 'tab',
  bs: 'backspace',
  del: 'delete',
  delete: 'delete',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  lt: '<',
  bar: '|',
  bslash: '\\'
}

const MODIFIER_MAP: Record<string, string> = {
  c: 'ctrl',
  s: 'shift',
  m: 'alt',
  a: 'alt',
  d: 'meta'
}

// Split an lhs into key tokens: each is a "<...>" special or a single char.
function tokenizeLhs(lhs: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < lhs.length) {
    if (lhs[index] === '<') {
      const end = lhs.indexOf('>', index)
      if (end === -1) {
        tokens.push(lhs[index])
        index += 1
        continue
      }
      tokens.push(lhs.slice(index, end + 1))
      index = end + 1
      continue
    }
    tokens.push(lhs[index])
    index += 1
  }
  return tokens
}

// One lhs token → grove serialized step ("ctrl+w", "space", "g"), or null when
// it uses a key notation grove can't represent.
function tokenToStep(token: string): string | null {
  if (token.length === 1) {
    if (token === ' ') return 'space'
    return token
  }
  const inner = token.slice(1, -1)
  const parts = inner.split('-')
  const modifiers: string[] = []
  let index = 0
  while (
    index < parts.length - 1 &&
    parts[index].length === 1 &&
    MODIFIER_MAP[parts[index].toLowerCase()]
  ) {
    modifiers.push(MODIFIER_MAP[parts[index].toLowerCase()])
    index += 1
  }
  const keyPart = parts.slice(index).join('-')
  if (!keyPart) return null

  const lower = keyPart.toLowerCase()
  let key: string
  if (SPECIAL_KEYS[lower]) key = SPECIAL_KEYS[lower]
  else if (/^f\d{1,2}$/.test(lower)) key = lower
  else if (keyPart.length === 1) key = keyPart
  else return null

  if (modifiers.length === 0) return key
  return [...modifiers, key].join('+')
}

// nvim lhs → grove serialized sequence, only when it is a space-leader map with
// at least one following key. Returns null otherwise.
function lhsToGroveKeys(lhs: string): string | null {
  const steps = tokenizeLhs(lhs).map(tokenToStep)
  if (steps.some((step) => step === null)) return null
  const parts = steps as string[]
  if (parts.length < 2 || parts[0] !== 'space') return null
  // Canonicalize into the bracket grammar (<Leader> f f, <Leader> <Ctrl-W>).
  return normalizeSequence(['leader', ...parts.slice(1)].join(' '))
}

// Build grove bindings for the leader-prefixed maps in `mappings`. `forward`
// replays the original lhs into nvim when grove completes the sequence.
export function nvimKeymapBindings(
  mappings: NvimMapping[],
  context: string,
  mode: string,
  forward: (lhs: string) => void
): KeyBinding[] {
  const bindings: KeyBinding[] = []
  const seen = new Set<string>()
  for (const mapping of mappings) {
    if (!mapping.lhs) continue
    const keys = lhsToGroveKeys(mapping.lhs)
    if (!keys || seen.has(keys)) continue
    seen.add(keys)
    const description = (mapping.desc && mapping.desc.trim()) || mapping.rhs || mapping.lhs
    const lhs = mapping.lhs
    bindings.push({
      id: `nvim:${mode}:${keys}`,
      keys,
      context,
      mode,
      group: 'Neovim',
      description,
      run: () => forward(lhs)
    })
  }
  return bindings
}
