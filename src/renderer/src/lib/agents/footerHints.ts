/**
 * What the line under the prompt tells the user: the hints for keys that matter right
 * now, named by the keys that are bound to them at the moment, and the warning that
 * the context is running out.
 */

export interface FooterHint {
  /** The keys as keycaps show them. */
  keys: string
  text: string
}

export interface FooterHintState {
  /** A turn is in flight. */
  running: boolean
  /** A command the session started is still running. */
  commandRunning: boolean
  /** The keys that cycle the permission mode now; empty when unbound. */
  cycleModeKeys: string[]
  /** The keys that send the running command to the background now; empty when unbound. */
  backgroundKeys: string[]
}

/** The key the composer stops a turn with; it is not a binding, so it cannot be rebound. */
const INTERRUPT_KEY = 'Esc'

/** A hint for a binding, left out when the binding has no keys. */
function hintFor(keys: string[], text: string): FooterHint[] {
  if (keys.length === 0) return []
  return [{ keys: keys.join(' '), text }]
}

/** The hints that apply to what the session is doing, in the order they are shown. */
export function footerHintsOf(state: FooterHintState): FooterHint[] {
  const hints: FooterHint[] = hintFor(state.cycleModeKeys, 'cycle mode')
  if (state.running) hints.push({ keys: INTERRUPT_KEY, text: 'interrupt' })
  if (state.commandRunning) {
    hints.push(...hintFor(state.backgroundKeys, 'run in background'))
  }
  return hints
}

/** The share of the context left at which the warning appears. */
const CONTEXT_LOW_RATIO = 0.85

/** Whether the share of the context used is high enough to warn about. */
export function contextIsLow(ratio: number): boolean {
  return ratio >= CONTEXT_LOW_RATIO
}

/** The warning for a context that is running out, naming what is left. */
export function contextLowMessage(ratio: number): string {
  const remaining = Math.max(0, Math.round((1 - ratio) * 100))
  return `Context low: ${remaining}% left. Run /compact to free some.`
}
