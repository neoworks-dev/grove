// What may be drawn on top of a Neovim pane's canvas, as a registry rather than
// a list of imports inside NvimPane.
//
// The review controls grove ships are core components, but a plugin can need
// the same surface — the GitHub pane's comment box has to open over the line it
// is about, which is a position only the pane it is drawn in knows. Registering
// keeps the editor from importing plugins, which is the wrong way round.

import type { Component } from 'svelte'

export interface EditorOverlay {
  id: string
  /** Rendered inside the pane, given `leafId` and the pane's redraw `tick`. */
  component: Component<{ leafId: string; tick: number }>
}

class EditorOverlayRegistry {
  overlays = $state<EditorOverlay[]>([])

  /** Register (or replace by id) an overlay; returns the inverse. */
  register(overlay: EditorOverlay): () => void {
    const others = this.overlays.filter((entry) => entry.id !== overlay.id)
    this.overlays = [...others, overlay]
    return () => {
      this.overlays = this.overlays.filter((entry) => entry.id !== overlay.id)
    }
  }
}

export const editorOverlays = new EditorOverlayRegistry()
