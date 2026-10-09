// Tells a tap of Space from a hold, so the dictation key can still type spaces.
// A press is pending until it has been held for holdMs. A tap released before then
// is just a space and nothing starts. A press still held when the timer fires
// becomes a hold, and onHold runs once; the caller then removes the space the
// keypress typed, since the keys that were typed in the meantime belong to the
// prompt, not to the dictation.

/** How long Space must stay down before it becomes a dictation. */
export const SPACE_HOLD_MS = 300

export class SpaceHold {
  #timer: ReturnType<typeof setTimeout> | null = null
  #held = false
  readonly #holdMs: number
  readonly #onHold: () => void

  constructor(onHold: () => void, holdMs: number) {
    this.#onHold = onHold
    this.#holdMs = holdMs
  }

  /** True while a press is pending or has already become a hold. */
  isActive(): boolean {
    return this.#timer !== null || this.#held
  }

  /** Starts a press. A press already pending or held is ignored. */
  press(): void {
    if (this.isActive()) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#held = true
      this.#onHold()
    }, this.#holdMs)
  }

  /** Ends the press, returning true when it had become a hold that now has to be finished. */
  release(): boolean {
    if (this.#held) {
      this.#held = false
      return true
    }
    this.reset()
    return false
  }

  /** Forgets any pending or held press without calling onHold. */
  reset(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#held = false
  }
}
