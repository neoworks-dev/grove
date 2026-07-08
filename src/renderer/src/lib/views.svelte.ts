// View registry — named split-tree configurations shown in the header (e.g.
// Code, Review). Base views register in coreViews.ts; plugins register theirs
// through the SDK with trees of their own pane types. Per-repo mutations of a
// view's tree persist under its id (see layout.svelte.ts).

import type { LayoutNode } from './layoutTree'

export interface ViewDefinition {
  id: string
  label: string
  order: number
  // Fresh default tree; called (and cloned by construction) per activation.
  buildTree: () => LayoutNode
  // Pane type to focus after switching.
  initialFocus?: string
}

class ViewRegistry {
  views = $state<ViewDefinition[]>([])

  // Register (or replace by id) a view; list stays sorted by order.
  register(view: ViewDefinition): () => void {
    const others = this.views.filter((entry) => entry.id !== view.id)
    this.views = [...others, view].sort((a, b) => a.order - b.order)
    return () => {
      this.views = this.views.filter((entry) => entry.id !== view.id)
    }
  }

  get(id: string): ViewDefinition | null {
    return this.views.find((entry) => entry.id === id) || null
  }
}

export const views = new ViewRegistry()
