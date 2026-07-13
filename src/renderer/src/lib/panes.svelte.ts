// Pane type registry — the canonical "what can live inside a window" list.
// Base panes register in corePanes.ts; plugins register through the SDK (their
// component is a generic declarative surface renderer). Leaves of the layout
// tree reference pane types by id, so registration order never matters and a
// missing type renders a placeholder until its plugin loads.

import type { Component } from 'svelte'

export interface PaneTypeContext {
  leafId: string
  state: Record<string, unknown>
  updateState: (patch: Record<string, unknown>) => void
}

export interface PaneType {
  id: string
  title: string
  // Rail icon (phosphor component); required when `rail` is set.
  icon?: Component
  // Rendered inside a PaneLeaf; receives PaneTypeContext as props.
  component: Component
  // Enforced by split gutters while dragging (px).
  minWidth?: number
  minHeight?: number
  // Present => the type appears in the ActivityBar launcher rail.
  rail?: { order: number }
  // Types sharing a slot replace each other in the tree instead of opening a
  // second window (e.g. the sidebar family, or the editor/diff/preview group).
  slot?: string
  // Extra classes on the leaf container (e.g. 'bg-elevated' for chrome panes).
  containerClass?: string
  // Keymap context this pane reports, when it differs from `id`. Lets several
  // pane types share one binding context — e.g. the Neovim editor reports
  // 'editor', so editor-scoped keybindings match it.
  contextType?: string
  // Editor-style modes the pane supports (first entry = default). Feeds the
  // keymap's mode gate and the statusline mode indicator; mode-scoped
  // keybindings only fire while the pane is in that mode.
  modes?: string[]
  // When false the leaf shows the "open a repository" placeholder.
  when?: () => boolean
}

class PaneRegistry {
  types = $state<PaneType[]>([])

  // Register (or replace by id) a pane type; returns an unregister function.
  register(type: PaneType): () => void {
    const others = this.types.filter((entry) => entry.id !== type.id)
    this.types = [...others, type]
    return () => {
      this.types = this.types.filter((entry) => entry.id !== type.id)
    }
  }

  get(id: string): PaneType | null {
    return this.types.find((entry) => entry.id === id) || null
  }

  railTypes(): PaneType[] {
    return this.types
      .filter((entry) => entry.rail)
      .sort((a, b) => (a.rail?.order ?? 0) - (b.rail?.order ?? 0))
  }
}

export const panes = new PaneRegistry()
