// KeyboardEvent → vim key-notation encoder for nvim_input. Returns null when
// the event should not be forwarded (lone modifiers, IME composition, dead
// keys) so the caller leaves it to the browser.

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

const SPECIAL_KEYS: Record<string, string> = {
  Escape: 'Esc',
  Enter: 'CR',
  Tab: 'Tab',
  Backspace: 'BS',
  Delete: 'Del',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12'
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'])

export function encodeKeyEvent(event: KeyEventLike): string | null {
  if (event.isComposing) return null
  if (MODIFIER_KEYS.has(event.key)) return null
  if (event.key === 'Dead' || event.key === 'Unidentified') return null

  const special = SPECIAL_KEYS[event.key]
  const printable = !special && event.key.length === 1

  if (!special && !printable) return null

  // AltGr on Linux/Windows reports ctrl+alt with the composed char — send the
  // char itself, not a chord.
  if (printable && event.ctrlKey && event.altKey && !/[a-zA-Z]/.test(event.key)) {
    return escapeChar(event.key)
  }

  const hasChord = event.ctrlKey || event.altKey || event.metaKey
  if (printable && !hasChord) {
    return escapeChar(event.key)
  }

  let name: string
  if (special) {
    name = special
  } else if (event.key === ' ') {
    name = 'Space'
  } else {
    name = event.key === '<' ? 'lt' : event.key
  }

  let mods = ''
  // Shift is only meaningful on specials — printables already carry it.
  if (event.shiftKey && special) mods += 'S-'
  if (event.ctrlKey) mods += 'C-'
  if (event.altKey) mods += 'A-'
  if (event.metaKey) mods += 'D-'
  if (!mods && special) return `<${name}>`
  if (!mods) return escapeChar(event.key)
  return `<${mods}${name}>`
}

function escapeChar(char: string): string {
  if (char === '<') return '<lt>'
  return char
}
