// Pure helpers for the keymap (no runes), so they can be unit-tested without a
// Svelte/DOM runtime. keymap.svelte.ts imports these.

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

// Whether `seq` begins with every token in `prefix`.
export function startsWith(seq: string[], prefix: string[]): boolean {
  if (prefix.length > seq.length) return false
  return prefix.every((token, index) => seq[index] === token)
}

// Nearest pane whose center lies in the given direction from the active pane.
// Returns the winning id, or null if nothing lies that way.
export function pickNeighbor(
  active: Rect,
  others: { id: string; rect: Rect }[],
  dir: 'h' | 'j' | 'k' | 'l'
): string | null {
  const ax = active.left + active.width / 2
  const ay = active.top + active.height / 2
  const horizontal = dir === 'h' || dir === 'l'

  let best: string | null = null
  let bestScore = Infinity
  for (const { id, rect } of others) {
    const dx = rect.left + rect.width / 2 - ax
    const dy = rect.top + rect.height / 2 - ay
    if (dir === 'h' && dx > -1) continue
    if (dir === 'l' && dx < 1) continue
    if (dir === 'k' && dy > -1) continue
    if (dir === 'j' && dy < 1) continue
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy)
    const cross = horizontal ? Math.abs(dy) : Math.abs(dx)
    const score = primary + cross * 2
    if (score < bestScore) {
      bestScore = score
      best = id
    }
  }
  return best
}
