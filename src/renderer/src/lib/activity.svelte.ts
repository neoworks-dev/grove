// Sidebar view registry driving the left activity bar. Each view has an icon
// (a phosphor-svelte component) for the rail and a body component rendered in
// the docked sidebar. Plugin-extensible, mirroring the commands/theme registries.

import type { Component } from 'svelte'

export interface SidebarView {
  id: string
  label: string
  icon: Component // phosphor icon component
  view: Component // sidebar body component
  order: number
}

class ActivityRegistry {
  views = $state<SidebarView[]>([])
  activeView = $state<string>('files')

  // Register (or replace by id) a view; list stays sorted by order.
  register(view: SidebarView): () => void {
    const others = this.views.filter((entry) => entry.id !== view.id)
    this.views = [...others, view].sort((a, b) => a.order - b.order)
    return () => {
      this.views = this.views.filter((entry) => entry.id !== view.id)
    }
  }

  setActive(id: string): void {
    if (this.views.some((view) => view.id === id)) this.activeView = id
  }

  get active(): SidebarView | null {
    return this.views.find((view) => view.id === this.activeView) || this.views[0] || null
  }
}

export const activity = new ActivityRegistry()
