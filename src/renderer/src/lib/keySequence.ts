// Key sequence grammar (no runes) — parsing, formatting, and matching for
// keybindings. Canonical serialized form, human-editable in settings files:
//
//   sequence := step (' ' step)*
//   step     := chord | key
//   chord    := (modifier '+')+ key
//   modifier := 'ctrl' | 'alt' | 'shift' | 'meta'   (canonical order)
//   key      := named key | single printable character
//
// Examples: "ctrl+k ctrl+s", "leader a b", "ctrl+h", "F".
// 'leader' is only valid as the first step. For bare printable characters
// shift is never written — the character itself encodes it ("F", not
// "shift+f"); shift only appears alongside other modifiers or on named keys.

export interface KeyStep {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export interface ParsedSequence {
  leader: boolean
  steps: KeyStep[]
}

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const

const NAMED_KEYS = new Set([
  'space',
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`)
])

const EVENT_KEY_NAMES: Record<string, string> = {
  ' ': 'space',
  spacebar: 'space',
  enter: 'enter',
  escape: 'escape',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown'
}

function isNamedKey(key: string): boolean {
  return NAMED_KEYS.has(key)
}

function hasNonShiftModifier(step: KeyStep): boolean {
  return step.ctrl || step.alt || step.meta
}

// Canonical form: chords lowercase their character and keep the shift flag;
// bare printable characters drop shift (the character encodes it).
function normalizeStep(step: KeyStep): KeyStep | null {
  if (isNamedKey(step.key)) return step
  if (step.key.length !== 1) return null
  if (hasNonShiftModifier(step)) return { ...step, key: step.key.toLowerCase() }
  if (!step.shift) return step
  // Bare shift+letter → the uppercase character. Other shifted characters
  // depend on keyboard layout and cannot be resolved from the base key.
  if (!/[a-z]/i.test(step.key)) return null
  return { ...step, key: step.key.toUpperCase(), shift: false }
}

function parseStep(text: string): KeyStep | null {
  const parts = text.split('+')
  if (parts.some((part) => part.length === 0)) return null
  const rawKey = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map((part) => part.toLowerCase())
  const step: KeyStep = {
    key: rawKey.length === 1 ? rawKey : rawKey.toLowerCase(),
    ctrl: mods.includes('ctrl'),
    alt: mods.includes('alt'),
    shift: mods.includes('shift'),
    meta: mods.includes('meta')
  }
  const unknown = mods.filter((mod) => !MODIFIERS.includes(mod as (typeof MODIFIERS)[number]))
  if (unknown.length > 0) return null
  if (!isNamedKey(step.key) && step.key.length !== 1) return null
  return normalizeStep(step)
}

// Parse a serialized sequence. Returns null on invalid input (hand-edited
// settings files) so callers can ignore the binding with a warning.
export function parseSequence(text: string): ParsedSequence | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const leader = tokens[0].toLowerCase() === 'leader'
  const stepTokens = leader ? tokens.slice(1) : tokens
  if (leader && stepTokens.length === 0) return null
  if (stepTokens.some((token) => token.toLowerCase() === 'leader')) return null
  const steps: KeyStep[] = []
  for (const token of stepTokens) {
    const step = parseStep(token)
    if (!step) return null
    steps.push(step)
  }
  return { leader, steps }
}

export function formatStep(step: KeyStep): string {
  const parts: string[] = []
  if (step.ctrl) parts.push('ctrl')
  if (step.alt) parts.push('alt')
  if (step.shift) parts.push('shift')
  if (step.meta) parts.push('meta')
  parts.push(step.key)
  return parts.join('+')
}

export function formatSequence(parsed: ParsedSequence): string {
  const steps = parsed.steps.map(formatStep).join(' ')
  if (!parsed.leader) return steps
  if (steps.length === 0) return 'leader'
  return `leader ${steps}`
}

// Round-trip a hand-written sequence into canonical form; null when invalid.
export function normalizeSequence(text: string): string | null {
  const parsed = parseSequence(text)
  if (!parsed) return null
  return formatSequence(parsed)
}

export function stepFromEvent(event: KeyboardEvent): KeyStep {
  const named = EVENT_KEY_NAMES[event.key.toLowerCase()]
  const isFunctionKey = /^f([1-9]|1[0-2])$/i.test(event.key)
  let key = event.key
  if (named) key = named
  if (isFunctionKey) key = event.key.toLowerCase()
  const step: KeyStep = {
    key,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey
  }
  const normalized = normalizeStep(step)
  if (normalized) return normalized
  // Unrepresentable steps (e.g. bare shift+digit) fall back to the raw key so
  // capture UIs can still display something; matching will simply never hit.
  return step
}

export function stepsEqual(a: KeyStep, b: KeyStep): boolean {
  return (
    a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta
  )
}

// Whether `steps` begins with every step in `prefix`.
export function sequenceStartsWith(steps: KeyStep[], prefix: KeyStep[]): boolean {
  if (prefix.length > steps.length) return false
  return prefix.every((step, index) => stepsEqual(steps[index], step))
}

export function isModifierKey(eventKey: string): boolean {
  return ['Shift', 'Control', 'Alt', 'Meta'].includes(eventKey)
}

// ── Conflict detection ──────────────────────────────────────────

export interface ConflictEntry {
  id: string
  context: string
  sequence: ParsedSequence
}

export interface SequenceConflict {
  firstId: string
  secondId: string
  context: string
  // 'duplicate': identical sequences. 'shadow': the shorter sequence fires
  // immediately on exact match, so the longer one can never trigger.
  kind: 'duplicate' | 'shadow'
}

export function findConflicts(entries: ConflictEntry[]): SequenceConflict[] {
  const conflicts: SequenceConflict[] = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const conflict = compareEntries(entries[i], entries[j])
      if (conflict) conflicts.push(conflict)
    }
  }
  return conflicts
}

function compareEntries(a: ConflictEntry, b: ConflictEntry): SequenceConflict | null {
  if (a.context !== b.context) return null
  if (a.sequence.leader !== b.sequence.leader) return null
  const sameLength = a.sequence.steps.length === b.sequence.steps.length
  const [shorter, longer] = a.sequence.steps.length <= b.sequence.steps.length ? [a, b] : [b, a]
  if (!sequenceStartsWith(longer.sequence.steps, shorter.sequence.steps)) return null
  return {
    firstId: a.id,
    secondId: b.id,
    context: a.context,
    kind: sameLength ? 'duplicate' : 'shadow'
  }
}
