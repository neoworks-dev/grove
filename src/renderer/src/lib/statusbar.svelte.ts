// Bottom status bar registry. Each item is a self-contained Svelte component
// pinned to the left or right side and ordered within that side. Core items
// (git branch, clock) are registered in App.svelte; plugins register more,
// mirroring the commands/activity/theme registries.

import type { Component } from 'svelte'

export type StatusAlign = 'left' | 'right'

export interface StatusItem {
  id: string
  align: StatusAlign
  order: number
  component: Component
  // Passed to the component (declarative plugin items carry their id here).
  props?: Record<string, unknown>
}

class StatusBarRegistry {
  items = $state<StatusItem[]>([])

  // Register (or replace by id) an item; list stays sorted by order.
  register(item: StatusItem): () => void {
    const others = this.items.filter((entry) => entry.id !== item.id)
    this.items = [...others, item].sort((a, b) => a.order - b.order)
    return () => {
      this.items = this.items.filter((entry) => entry.id !== item.id)
    }
  }

  get left(): StatusItem[] {
    return this.items.filter((item) => item.align === 'left')
  }

  get right(): StatusItem[] {
    return this.items.filter((item) => item.align === 'right')
  }
}

export const statusBar = new StatusBarRegistry()
