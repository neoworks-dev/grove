// Which-key content for Neovim's *pending* key state — the keys nvim has
// swallowed but not yet acted on: a count (`5`), a prefix layer (`g`, `z`, `[`,
// `<C-w>`, a register/mark selector), or the start of a multi-key mapping.
//
// Nvim exposes none of this over RPC (`msg_showcmd` only exists under
// `ext_messages`, which grove does not attach with), so the editor pane streams
// every typed normal/visual-mode key over `vim.on_key` and grove reconstructs
// the pending prefix here. The builtin layers below are fixed — vim's own
// prefixes are not introspectable — but live normal-mode mappings are merged on
// top, so plugin-contributed prefixes appear without being listed here.

import type { HintEntry } from './keymap.svelte'
import { isTypableLhs, type NvimMapping } from './nvimKeymap'

// Control character → vim key notation, for the raw bytes `vim.on_key` reports.
const CONTROL_KEYS: Record<string, string> = {
  '\x1b': '<Esc>',
  '\r': '<CR>',
  '\n': '<NL>',
  '\t': '<Tab>',
  '\b': '<BS>',
  '\x7f': '<BS>'
}

/**
 * Decode one raw key as reported by `vim.on_key` into vim key notation
 * (`g`, `<C-w>`, `<Esc>`). Returns null for keys grove cannot represent —
 * notably nvim's internal K_SPECIAL sequences for arrows and mouse events —
 * which the caller treats as "sequence broken".
 */
export function decodeNvimKey(raw: string): string | null {
  if (!raw) return null
  const control = CONTROL_KEYS[raw]
  if (control) return control
  if (raw.length === 1) {
    const code = raw.charCodeAt(0)
    // C0 controls other than the named ones above are Ctrl chords.
    if (code < 0x20) {
      return `<C-${String.fromCharCode(code + 96)}>`
    }
    if (code === 0x80) return null
    return raw
  }
  // K_SPECIAL-prefixed multi-byte sequences (special keys, mouse) start at 0x80.
  if (raw.charCodeAt(0) === 0x80) return null
  return raw
}

// Titles for the builtin prefix layers, shown as `+goto`, `+window`, …
const PREFIX_TITLES: Record<string, string> = {
  g: 'goto',
  z: 'fold & scroll',
  '[': 'previous',
  ']': 'next',
  '"': 'register',
  "'": 'mark',
  '`': 'mark',
  Z: 'quit',
  m: 'set mark',
  q: 'record macro',
  '@': 'play macro',
  '<C-w>': 'window'
}

// The next key of each builtin prefix layer. Keys are what follows the prefix,
// matching how the operator-pending panel lists motions after `d`.
const PREFIX_ENTRIES: Record<string, HintEntry[]> = {
  g: [
    { keys: 'g', description: 'first line' },
    { keys: 'd', description: 'goto definition' },
    { keys: 'D', description: 'goto declaration' },
    { keys: 'f', description: 'open file under cursor' },
    { keys: 'i', description: 'insert at last edit' },
    { keys: 'v', description: 'reselect last visual' },
    { keys: 'j', description: 'down a screen line' },
    { keys: 'k', description: 'up a screen line' },
    { keys: '0', description: 'start of screen line' },
    { keys: '$', description: 'end of screen line' },
    { keys: 'e', description: 'end of previous word' },
    { keys: 'J', description: 'join without space' },
    { keys: 'u', description: 'lowercase (operator)' },
    { keys: 'U', description: 'uppercase (operator)' },
    { keys: '~', description: 'toggle case (operator)' },
    { keys: 'q', description: 'reflow (operator)' },
    { keys: ';', description: 'older change' },
    { keys: ',', description: 'newer change' },
    { keys: '*', description: 'search word (partial)' }
  ],
  z: [
    { keys: 'z', description: 'center line' },
    { keys: 't', description: 'line to top' },
    { keys: 'b', description: 'line to bottom' },
    { keys: 'a', description: 'toggle fold' },
    { keys: 'o', description: 'open fold' },
    { keys: 'c', description: 'close fold' },
    { keys: 'R', description: 'open all folds' },
    { keys: 'M', description: 'close all folds' },
    { keys: 'f', description: 'create fold (operator)' },
    { keys: 'd', description: 'delete fold' },
    { keys: '=', description: 'spelling suggestions' },
    { keys: 'g', description: 'add word to dictionary' },
    { keys: 'w', description: 'mark word bad' }
  ],
  '[': [
    { keys: '[', description: 'previous section' },
    { keys: '{', description: 'previous unmatched {' },
    { keys: '(', description: 'previous unmatched (' },
    { keys: 'm', description: 'previous method start' },
    { keys: 'c', description: 'previous change' },
    { keys: 'd', description: 'previous diagnostic' },
    { keys: 's', description: 'previous misspelling' }
  ],
  ']': [
    { keys: ']', description: 'next section' },
    { keys: '}', description: 'next unmatched }' },
    { keys: ')', description: 'next unmatched )' },
    { keys: 'm', description: 'next method start' },
    { keys: 'c', description: 'next change' },
    { keys: 'd', description: 'next diagnostic' },
    { keys: 's', description: 'next misspelling' }
  ],
  '"': [
    { keys: 'a–z', description: 'named register' },
    { keys: '+', description: 'system clipboard' },
    { keys: '*', description: 'selection clipboard' },
    { keys: '0', description: 'last yank' },
    { keys: '"', description: 'unnamed register' },
    { keys: '_', description: 'black hole' }
  ],
  "'": [
    { keys: 'a–z', description: 'jump to mark (line)' },
    { keys: "'", description: 'previous position' },
    { keys: '.', description: 'last change' },
    { keys: '^', description: 'last insert' }
  ],
  '`': [
    { keys: 'a–z', description: 'jump to mark (column)' },
    { keys: '`', description: 'previous position' },
    { keys: '.', description: 'last change' },
    { keys: '^', description: 'last insert' }
  ],
  Z: [
    { keys: 'Z', description: 'write and quit' },
    { keys: 'Q', description: 'quit without writing' }
  ],
  m: [{ keys: 'a–z', description: 'set mark' }],
  q: [
    { keys: 'a–z', description: 'record into register' },
    { keys: ':', description: 'command-line window' }
  ],
  '@': [
    { keys: 'a–z', description: 'play register' },
    { keys: '@', description: 'repeat last macro' },
    { keys: ':', description: 'repeat last command' }
  ],
  '<C-w>': [
    { keys: 's', description: 'split horizontally' },
    { keys: 'v', description: 'split vertically' },
    { keys: 'w', description: 'next window' },
    { keys: 'h', description: 'window left' },
    { keys: 'j', description: 'window down' },
    { keys: 'k', description: 'window up' },
    { keys: 'l', description: 'window right' },
    { keys: 'q', description: 'close window' },
    { keys: 'o', description: 'close other windows' },
    { keys: '=', description: 'equalize sizes' },
    { keys: 'T', description: 'move to new tab' }
  ]
}

// Top-level keys worth showing while only a count is pending.
const COUNT_ENTRIES: HintEntry[] = [
  { keys: 'j', description: 'lines down' },
  { keys: 'k', description: 'lines up' },
  { keys: 'w', description: 'words forward' },
  { keys: 'b', description: 'words back' },
  { keys: 'G', description: 'to line' },
  { keys: 'd', description: 'delete (operator)' },
  { keys: 'c', description: 'change (operator)' },
  { keys: 'y', description: 'yank (operator)' },
  { keys: '>', description: 'indent (operator)' },
  { keys: '<', description: 'dedent (operator)' },
  { keys: 'p', description: 'paste' },
  { keys: 'x', description: 'delete char' },
  { keys: 'u', description: 'undo' },
  { keys: '.', description: 'repeat' }
]

// Split a pending string into its leading count and the rest ("5g" → 5, "g").
// A leading 0 is the start-of-line motion, never a count.
function splitCount(pending: string): { count: string; rest: string } {
  const match = /^[1-9][0-9]*/.exec(pending)
  if (!match) return { count: '', rest: pending }
  return { count: match[0], rest: pending.slice(match[0].length) }
}

// Live mappings whose lhs continues past `prefix` (so the prefix is a real
// layer with something reachable behind it).
function mapsUnder(prefix: string, mappings: NvimMapping[]): NvimMapping[] {
  return mappings.filter((mapping) => {
    if (!mapping.lhs) return false
    if (mapping.lhs.length <= prefix.length) return false
    if (!isTypableLhs(mapping.lhs)) return false
    return mapping.lhs.startsWith(prefix)
  })
}

/**
 * Is `pending` a key sequence nvim is still waiting to complete? True for a
 * bare count, a builtin prefix layer, and any prefix of a live mapping.
 */
export function isPendingSequence(pending: string, mappings: NvimMapping[]): boolean {
  if (!pending) return false
  const { count, rest } = splitCount(pending)
  if (!rest) return count.length > 0
  if (PREFIX_ENTRIES[rest]) return true
  return mapsUnder(rest, mappings).length > 0
}

/**
 * Fold one newly typed key into the pending sequence, returning the new pending
 * string ('' when the sequence resolved, was cancelled, or never started).
 */
export function nextPending(pending: string, key: string, mappings: NvimMapping[]): string {
  if (key === '<Esc>') return ''
  const candidate = pending + key
  if (isPendingSequence(candidate, mappings)) return candidate
  return ''
}

export interface PendingHint {
  title: string
  entries: HintEntry[]
}

// The panel title: the prefix's name, prefixed by the count when there is one.
function hintTitle(count: string, rest: string): string {
  const name = PREFIX_TITLES[rest] || rest
  if (!rest) return `count ${count}`
  if (!count) return name
  return `${count} ${name}`
}

/**
 * Which-key panel content for a pending sequence: the builtin layer's keys
 * merged with the live mappings that continue past the same prefix. Builtins
 * win on collision, mirroring the operator-pending panel. Returns null when
 * nothing is pending.
 */
export function pendingHint(pending: string, mappings: NvimMapping[]): PendingHint | null {
  if (!isPendingSequence(pending, mappings)) return null
  const { count, rest } = splitCount(pending)

  const entries: HintEntry[] = []
  const seen = new Set<string>()
  const builtins = rest ? PREFIX_ENTRIES[rest] : COUNT_ENTRIES
  for (const entry of builtins || []) {
    seen.add(entry.keys)
    entries.push(entry)
  }

  // A bare count has no prefix to match mappings against — every mapping would
  // "continue past" the empty string.
  const liveMaps = rest ? mapsUnder(rest, mappings) : []
  for (const mapping of liveMaps) {
    const keys = mapping.lhs.slice(rest.length)
    if (seen.has(keys)) continue
    seen.add(keys)
    const description = (mapping.desc && mapping.desc.trim()) || mapping.rhs || mapping.lhs
    entries.push({ keys, description })
  }

  return { title: hintTitle(count, rest), entries }
}
