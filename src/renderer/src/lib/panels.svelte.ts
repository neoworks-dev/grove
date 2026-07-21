// Bottom-panel view registry. A panel view is a tab in the bottom panel that
// renders an existing pane type (by id) as its body — so terminal, diagnostics,
// and plugin panes are all shown through the same tab strip. Core registers its
// views directly; plugins opt a contributed pane into the panel via the
// manifest `panel` flag, which the plugin host turns into a register() call.

import type { Component } from 'svelte'

export interface PanelView {
  id: string
  title: string
  // Pane type rendered as this tab's body (resolved through the pane registry).
  paneTypeId: string
  icon?: Component
  order?: number
}

class PanelRegistry {
  views = $state<PanelView[]>([])

  // Register (or replace by id) a panel view. Returns an unregister function.
  register(view: PanelView): () => void {
    const others = this.views.filter((entry) => entry.id !== view.id)
    this.views = [...others, view]
    return () => {
      this.views = this.views.filter((entry) => entry.id !== view.id)
    }
  }

  // Views in display order.
  get sorted(): PanelView[] {
    return [...this.views].sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
  }
}

export const panels = new PanelRegistry()
