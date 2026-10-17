// Ordering and fan-out for the window's keydown pipeline, ported from Grove's
// keyDispatchCore. One window listener owns every key that nothing focused took.
// Subscribers run from highest priority to lowest and the first to claim the key ends
// the chain. Unlike the Electron app there is no focused-pane sink: a native element
// such as the editor hears its keys through GPUI before they ever reach the window.

import type { KeyEventLike } from './keySequence'

/** A window key event: the DOM's modifier names plus the two calls that end its delivery. */
export interface KeyEventInput extends KeyEventLike {
  preventDefault(): void
  stopPropagation(): void
}

/**
 * A global key handler. Returns true when it claims the key, which ends the
 * chain: no lower-priority subscriber runs.
 *
 * Claiming does not by itself stop delivery to the host. A handler that also wants to
 * keep the key away from a focused field must call `event.preventDefault()` — the two
 * are separate questions. An overlay claims the key (so no binding fires) but lets it
 * through, because its own input still has to receive the keystroke; a keybinding does both.
 */
export type KeyHandler = (event: KeyEventInput) => boolean

/**
 * Precedence tiers for global key subscribers. Higher runs first; equal
 * priorities run in registration order.
 */
export const KeyPriority = {
  /** The keybind recorder owns the keyboard outright while recording. */
  capture: 100,
  /** Modal dialogs: Escape cancels before any binding can claim it. */
  dialog: 90,
  /** Keys that must work in any context, even under an overlay (F1). */
  hardKey: 85,
  /** An open overlay types into its own input, so the chain stands down. */
  overlay: 80,
  /** Open menus close on Escape. */
  menu: 70,
  /** The keybinding registry: leader sequences, chords and bare keys. */
  bindings: 40,
  /** App keys that must lose to a user binding. */
  app: 20
} as const

interface Subscription {
  order: number
  priority: number
  handle: KeyHandler
}

function byPriorityThenRegistration(first: Subscription, second: Subscription): number {
  if (first.priority !== second.priority) return second.priority - first.priority
  return first.order - second.order
}

export class KeyDispatcher {
  private subscriptions: Subscription[] = []
  private nextOrder = 0

  /**
   * Register a global key handler at the given priority tier.
   * Returns an unsubscribe function.
   */
  subscribe(priority: number, handle: KeyHandler): () => void {
    const subscription: Subscription = { order: this.nextOrder, priority, handle }
    this.nextOrder += 1
    this.subscriptions = [...this.subscriptions, subscription].sort(byPriorityThenRegistration)
    return () => {
      this.subscriptions = this.subscriptions.filter((entry) => entry !== subscription)
    }
  }

  /** Run one keystroke through the subscriber chain; true when a subscriber claimed it. */
  dispatch(event: KeyEventInput): boolean {
    // Iterating the captured array keeps a handler that unsubscribes mid-chain
    // (a dialog closing itself) from reindexing the loop.
    for (const subscription of this.subscriptions) {
      if (subscription.handle(event)) return true
    }
    return false
  }
}
