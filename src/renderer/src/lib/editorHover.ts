// A CodeMirror tooltip shown on demand (the `K` hover keybind), as opposed to
// the mouse-driven hoverTooltip. Dispatch setHoverTooltip with a tooltip to
// show it; it clears itself on the next edit or cursor move.

import { StateEffect, StateField } from '@codemirror/state'
import { showTooltip, type Tooltip } from '@codemirror/view'

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
      const dom = document.createElement('div')
      dom.className = 'cm-lsp-hover'
      dom.textContent = text
      return { dom }
    }
  }
}
