// A walkthrough: an agent's answer to "how does this flow", stepped through.
//
// A location card marked as steps is read in order. Starting it opens the first
// step the way picking a row does — the file, its lines marked, the note above
// them — and from there the user moves on from the editor (a bar in it, or
// Alt+Left and Alt+Right) without going back to the conversation. Only one runs
// at a time. Clearing the marks leaves the place kept, so Next picks up where
// the user stopped; only ending the walkthrough forgets it.

import { clearAgentMarks } from '../store.svelte'
import { openLocationInEditor, resolveLocations } from './locations'
import type { CodeLocation } from './types'

export interface Walk {
  /** The card the steps came from, so it can show which step is on screen. */
  cardId: string
  title?: string
  /** The worktree the session runs in; step paths may be relative to it. */
  root: string
  steps: CodeLocation[]
  index: number
}

class WalkthroughStore {
  current = $state<Walk | null>(null)

  /** Start walking a card's steps, at the first or at the one picked. */
  start(cardId: string, root: string, steps: CodeLocation[], title?: string, index = 0): void {
    // Card views are Svelte state; keep a plain copy that outlives the card.
    const plain = JSON.parse(JSON.stringify(steps)) as CodeLocation[]
    this.current = { cardId, title, root, steps: plain, index: 0 }
    void this.go(index)
  }

  /** Open one step, where its code is now. */
  async go(index: number): Promise<void> {
    const walk = this.current
    if (!walk || index < 0 || index >= walk.steps.length) return
    walk.index = index
    const [place] = await resolveLocations(walk.root, [walk.steps[index]])
    // Moved on while the step was looked up.
    if (this.current !== walk || walk.index !== index) return
    openLocationInEditor(walk.root, place.location, place.state)
  }

  /** The next step; nothing after the last. */
  next(): void {
    if (!this.current) return
    void this.go(this.current.index + 1)
  }

  /** The step before; nothing before the first. */
  previous(): void {
    if (!this.current) return
    void this.go(this.current.index - 1)
  }

  /** Stop the walkthrough and take its mark off the editor. */
  end(): void {
    this.current = null
    clearAgentMarks()
  }

  /** The step on screen, when this card's walkthrough is the one running. */
  stepOf(cardId: string): number | null {
    if (!this.current || this.current.cardId !== cardId) return null
    return this.current.index
  }
}

export const walkthrough = new WalkthroughStore()
