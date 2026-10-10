/**
 * Escape pressed twice in the composer. A single Escape keeps meaning "interrupt";
 * the second one, close behind, clears a draft or, with nothing to clear, opens
 * the rewind view.
 */

/** How long after an Escape a second one still counts as the other half of a double press. */
export const DOUBLE_ESCAPE_MS = 500

/** What an Escape in the composer does. */
export type EscapeAction =
  /** Stop the turn in flight. */
  | 'interrupt'
  /** Empty the draft, keeping it in prompt history. */
  | 'clear'
  /** Open the rewind view. */
  | 'rewind'
  /** Nothing yet: wait for a possible second press. */
  | 'none'

export interface EscapeContext {
  /** A turn is in flight. */
  running: boolean
  /** The composer holds text or attachments. */
  hasDraft: boolean
  /** This is the second Escape of a double press. */
  doublePress: boolean
}

/** Remembers when the last Escape was pressed, to tell a double press from two single ones. */
export class DoubleEscape {
  private lastPressAt = Number.NEGATIVE_INFINITY

  /** Records an Escape at the given time; true when it is the second of a double press. */
  press(now: number): boolean {
    const doublePress = now - this.lastPressAt <= DOUBLE_ESCAPE_MS
    if (doublePress) {
      this.lastPressAt = Number.NEGATIVE_INFINITY
      return true
    }
    this.lastPressAt = now
    return false
  }
}

/** Decides what an Escape does: a second press clears a draft first, then opens rewind once idle. */
export function escapeAction(context: EscapeContext): EscapeAction {
  if (context.doublePress && context.hasDraft) return 'clear'
  if (context.running) return 'interrupt'
  if (context.doublePress) return 'rewind'
  return 'none'
}
