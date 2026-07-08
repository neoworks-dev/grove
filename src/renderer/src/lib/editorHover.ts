// A CodeMirror tooltip shown on demand (the `K` hover keybind), as opposed to
// the mouse-driven hoverTooltip. Dispatch setHoverTooltip with a tooltip to
// show it; it clears itself on the next edit or cursor move.

import { StateEffect, StateField } from '@codemirror/state'
import { showTooltip, type Tooltip } from '@codemirror/view'
import { mount, unmount } from 'svelte'
import HoverTooltip from '../components/HoverTooltip.svelte'

// Mount the tooltip body (markdown type info in a FloatingScrollbar) into a
// host element. Shared by the mouse hover and the `K` keybind so both match.
// Returns the CodeMirror TooltipView shape (dom + destroy to unmount).
export function mountHoverTooltip(text: string): { dom: HTMLElement; destroy: () => void } {
  const dom = document.createElement('div')
  const component = mount(HoverTooltip, { target: dom, props: { text } })
  return {
    dom,
    destroy() {
      void unmount(component)
    }
  }
}

export const setHoverTooltip = StateEffect.define<Tooltip | null>()

export const hoverTooltipField = StateField.define<Tooltip | null>({
  create() {
    return null
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHoverTooltip)) return effect.value
    }
    // Any movement or edit dismisses the hover.
    if (value && (tr.docChanged || tr.selection)) return null
    return value
  },
  provide(field) {
    return showTooltip.from(field)
  }
})

export function hoverTooltipAt(pos: number, text: string): Tooltip {
  return {
    pos,
    above: true,
    create() {
      return mountHoverTooltip(text)
    }
  }
}
