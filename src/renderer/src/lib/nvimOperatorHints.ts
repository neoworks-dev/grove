// Which-key content for Neovim operator-pending mode (after d/c/y/…). Vim does
// not expose its built-in motions/text-objects through any API, so the base set
// below is a fixed list of the standard ones; plugin-provided operator maps
// (omap) are queried live and merged on top, so text objects contributed by
// plugins appear automatically next to the built-ins.

import type { HintEntry } from './keymap.svelte'
import type { NvimMapping } from './nvimKeymap'

// Operator key → the verb shown as the panel title (`+delete`, `+change`, …).
// Multi-key operators (g-prefixed) are matched on their full v:operator value.
const OPERATOR_TITLES: Record<string, string> = {
  d: 'delete',
  c: 'change',
  y: 'yank',
  '>': 'indent',
  '<': 'dedent',
  '=': 'format',
  '!': 'filter',
  gu: 'lowercase',
  gU: 'uppercase',
  'g~': 'toggle case',
  gq: 'reflow',
  zf: 'fold'
}

export function operatorTitle(operator: string): string {
  const known = OPERATOR_TITLES[operator]
  if (known) return known
  return 'operator'
}

// Standard built-in motions and text objects available after any operator.
const BUILTIN_MOTIONS: HintEntry[] = [
  { keys: 'w', description: 'word forward' },
  { keys: 'e', description: 'end of word' },
  { keys: 'b', description: 'word back' },
  { keys: '$', description: 'to end of line' },
  { keys: '0', description: 'to start of line' },
  { keys: '^', description: 'to first non-blank' },
  { keys: 'gg', description: 'to first line' },
  { keys: 'G', description: 'to last line' },
  { keys: '}', description: 'paragraph forward' },
  { keys: '{', description: 'paragraph back' },
  { keys: 'f', description: 'find char forward' },
  { keys: 't', description: 'till char forward' },
  { keys: '/', description: 'search' },
  { keys: 'iw', description: 'inner word' },
  { keys: 'aw', description: 'a word' },
  { keys: 'ip', description: 'inner paragraph' },
  { keys: 'ap', description: 'a paragraph' },
  { keys: 'i"', description: 'inside quotes' },
  { keys: 'i(', description: 'inside parens' },
  { keys: 'i{', description: 'inside braces' },
  { keys: 'i[', description: 'inside brackets' },
  { keys: 'it', description: 'inside tag' }
]

// Doubled operator (dd, cc, yy) — acts on the whole line.
function selfMotion(operator: string): HintEntry | null {
  if (operator.length !== 1) return null
  return { keys: operator, description: 'whole line' }
}

// Build the operator-pending which-key entries: built-in motions plus the live
// operator-pending maps from nvim, deduped by lhs (built-ins win on collision).
export function operatorHintEntries(operator: string, omaps: NvimMapping[]): HintEntry[] {
  const seen = new Set<string>()
  const entries: HintEntry[] = []

  const self = selfMotion(operator)
  if (self) {
    entries.push(self)
    seen.add(self.keys)
  }

  for (const entry of BUILTIN_MOTIONS) {
    if (seen.has(entry.keys)) continue
    seen.add(entry.keys)
    entries.push(entry)
  }

  for (const mapping of omaps) {
    const lhs = mapping.lhs
    if (!lhs || seen.has(lhs)) continue
    seen.add(lhs)
    const description = (mapping.desc && mapping.desc.trim()) || mapping.rhs || lhs
    entries.push({ keys: lhs, description })
  }

  return entries
}
