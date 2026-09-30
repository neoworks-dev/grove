// Cards shown under an agent's message for what it refers to.
//
// A message that names an issue reads better with the issue beside it — its
// state, its labels, who is on it — than with a bare `#212`. What counts as a
// reference, and what its card shows, belongs to the feature that knows about
// it, so features register a source here the way they register panes.

import type { Component } from 'svelte'

export interface MessageCardSource {
  id: string
  /** The references a message makes, in order and without repeats, as keys the card understands. */
  find(text: string): string[]
  component: Component<{ reference: string }>
}

// A message naming a dozen issues is a list, not a pointer at one; beyond a few
// the cards would bury the answer they are meant to support.
export const MAX_CARDS_PER_SOURCE = 3

class MessageCardRegistry {
  sources = $state<MessageCardSource[]>([])

  /** Add a source, replacing one with the same id; returns the unregister. */
  register(source: MessageCardSource): () => void {
    this.sources = [...this.sources.filter((entry) => entry.id !== source.id), source]
    return () => {
      this.sources = this.sources.filter((entry) => entry !== source)
    }
  }
}

export const messageCards = new MessageCardRegistry()
