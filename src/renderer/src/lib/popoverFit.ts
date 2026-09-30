// A popover opened from a control anchors to the control's left edge, which is
// wherever the control happened to wrap to. Near the right edge of a narrow
// pane that runs it off the pane and the window; this moves it back in.

import type { Action } from 'svelte/action'

/** The horizontal extent of a box on screen. */
export interface HorizontalSpan {
  left: number
  right: number
}

/**
 * How far to move a popover sideways so it ends inside its boundary; negative
 * is to the left. A popover wider than the boundary keeps its left edge inside,
 * since the start of each row is what a reader needs.
 */
export function horizontalShift(popover: HorizontalSpan, boundary: HorizontalSpan): number {
  const overflowRight = popover.right - boundary.right
  if (overflowRight <= 0) {
    return 0
  }
  const roomOnTheLeft = Math.max(0, popover.left - boundary.left)
  return -Math.min(overflowRight, roomOnTheLeft)
}

/** Moves the node sideways, once it is laid out, so it stays inside the boundary element. */
export const keepInside: Action<HTMLElement, HTMLElement | undefined> = (node, boundary) => {
  /** Measures the node where its classes put it, then shifts it back inside. */
  function fit(target: HTMLElement | undefined): void {
    node.style.translate = ''
    if (!target) {
      return
    }
    const shift = horizontalShift(node.getBoundingClientRect(), target.getBoundingClientRect())
    if (shift !== 0) {
      node.style.translate = `${shift}px 0`
    }
  }

  fit(boundary)
  return {
    update(next) {
      fit(next)
    }
  }
}
