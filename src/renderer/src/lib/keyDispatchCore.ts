// Ordering and fan-out for the global keydown pipeline. Kept free of runes and
// DOM so the precedence rules are testable on their own (same split as
// keymapCore/keymap and layoutTree/layout).
//
// One window listener owns every keystroke. Subscribers run from highest
// priority to lowest and the first to claim the key ends the chain; a key
// nobody claims falls through to the focused pane's sink, which is how the
// embedded editor receives input without registering a listener of its own.

/**
 * A global key handler. Returns true when it claims the key, which ends the
 * chain: no lower-priority subscriber runs and the focused pane's sink is
 * skipped.
 *
 * Claiming does not by itself stop DOM delivery. A handler that also wants to
 * keep the key away from the focused element must call `event.stopPropagation()`
 * — the two are separate questions. An overlay claims the key (so no binding
 * fires) but lets it propagate, because its own input still has to receive the
 * keystroke; a keybinding does both.
 */
export type KeyHandler = (event: KeyboardEvent) => boolean

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
  /** A focused terminal gets every key except the chord that hides it. */
  terminal: 60,
  /** The keybinding registry: leader sequences, chords and bare keys. */
  bindings: 40,
  /** App keys that must lose to a user binding (editor tab switching). */
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
  private paneSinks = new Map<string, KeyHandler>()
  private nextOrder = 0
  private readonly resolveActivePaneId: () => string | null

  /**
   * @param resolveActivePaneId Reads the currently focused pane id, used to
   *   pick the sink a key falls through to. Injected so the dispatcher stays
   *   independent of the keymap's reactive state.
   */
  constructor(resolveActivePaneId: () => string | null) {
    this.resolveActivePaneId = resolveActivePaneId
  }

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

  /**
   * Register a pane's fallthrough sink. It runs only while that pane is focused
   * and only for keys no subscriber claimed. Returns an unregister function.
   */
  registerPaneSink(paneId: string, handle: KeyHandler): () => void {
    this.paneSinks.set(paneId, handle)
    return () => {
      // Guard against clobbering a sink a later registration already replaced.
      if (this.paneSinks.get(paneId) === handle) this.paneSinks.delete(paneId)
    }
  }

  /**
   * Run one keystroke through the subscriber chain and, if nothing claimed it,
   * through the focused pane's sink.
   */
  dispatch(event: KeyboardEvent): void {
    // Iterating the captured array keeps a handler that unsubscribes mid-chain
    // (a dialog closing itself) from reindexing the loop.
    for (const subscription of this.subscriptions) {
      if (subscription.handle(event)) return
    }
    const paneId = this.resolveActivePaneId()
    if (!paneId) return
    const sink = this.paneSinks.get(paneId)
    if (!sink) return
    sink(event)
  }
}
