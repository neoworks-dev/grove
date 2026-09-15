// Pane type registry — the canonical "what can live inside a window" list.
// Base panes register in corePanes.ts; plugins register through the SDK (their
// component is a generic declarative surface renderer). Leaves of the layout
// tree reference pane types by id, so registration order never matters and a
// missing type renders a placeholder until its plugin loads.

import type { Component } from 'svelte'
import type { EdgeSide } from './layoutTree'

// Where a pane type lands when it is revealed and no leaf of it is open: pinned
// against an outer edge of the tree. `order` breaks ties when several types
// want the same edge (lowest wins, and it picks the type the default layout
// puts there); `fraction` is the share of the tree it takes on arrival.
export interface PaneEdge {
  side: EdgeSide
  order?: number
  fraction?: number
}

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
  // Present => this pane holds a pixel size instead of a share of the window.
  // It keeps its width when panes open, close or the window resizes; only a
  // drag on its own gutter changes it. The sidebar works this way.
  fixedSize?: { defaultPx: number }
  // How eagerly a pane takes space freed by a closing sibling, and (inversely)
  // gives space to one that opens. 1 is proportional — the default. Above 1
  // grows first and shrinks last (the editor); below 1 does the opposite (the
  // agent panel). Ignored for panes with a fixed size.
  growth?: number
  // Present => the type appears in the ActivityBar launcher rail.
  rail?: { order: number }
  // Types sharing a slot replace each other in the tree instead of opening a
  // second window (e.g. the sidebar family, or the editor/diff/preview group).
  slot?: string
  // Present => revealing this pane with no leaf of it open pins it against this
  // edge of the tree instead of splitting the anchor pane. The sidebar family
  // and the agent panel use it; both are ordinary draggable leaves otherwise.
  preferredEdge?: PaneEdge
  // When set, revealing this pane (ensurePane) splits the focused leaf in this
  // orientation instead of replacing the slot occupant — 'row' spawns it to the
  // side, 'column' below. Used by aux center panes (diagnostics, markdown).
  preferredOrientation?: 'row' | 'column'
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
  // Canvas-backed panes (nvim, terminal) scale their own font from the pane's
  // font zoom instead of the generic CSS `zoom` the container applies — CSS zoom
  // would rescale their bitmap and blur the text.
  ownsFontScale?: boolean
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

  // Types that want the given edge, most-preferred first. The default layout
  // takes the head of this list, so which pane occupies an edge stays a
  // registration detail rather than a hardcoded id in the layout store.
  edgeTypes(side: EdgeSide): PaneType[] {
    return this.types
      .filter((entry) => entry.preferredEdge?.side === side)
      .sort((a, b) => (a.preferredEdge?.order ?? 0) - (b.preferredEdge?.order ?? 0))
  }

  railTypes(): PaneType[] {
    return this.types
      .filter((entry) => entry.rail)
      .sort((a, b) => (a.rail?.order ?? 0) - (b.rail?.order ?? 0))
  }
}

export const panes = new PaneRegistry()
