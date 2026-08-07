// Geometry for the tmux-style focus tint on pane dividers (split gutters and
// dock resizers): the tint must span only the stretch of the divider the
// focused pane actually borders, not the divider's full length.

export interface DividerSegment {
  // Distance in px from the divider's start (top for a vertical divider, left
  // for a horizontal one) to where the focused pane begins alongside it.
  offset: number
  length: number
}

/**
 * The stretch of a divider that the focused pane runs alongside, measured from
 * live DOM rects. `axis` is the direction the divider extends in ('y' for a
 * vertical divider between columns, 'x' for a horizontal one between rows).
 * Returns null when the panes' extents do not overlap the divider's.
 */
export function dividerSegment(
  dividerEl: HTMLElement,
  paneEl: HTMLElement,
  axis: 'x' | 'y'
): DividerSegment | null {
  const divider = dividerEl.getBoundingClientRect()
  const pane = paneEl.getBoundingClientRect()
  if (axis === 'y') {
    return segmentOverlap(divider.top, divider.bottom, pane.top, pane.bottom)
  }
  return segmentOverlap(divider.left, divider.right, pane.left, pane.right)
}

/** Overlap of [paneStart, paneEnd] with [dividerStart, dividerEnd], relative to the divider. */
export function segmentOverlap(
  dividerStart: number,
  dividerEnd: number,
  paneStart: number,
  paneEnd: number
): DividerSegment | null {
  const start = Math.max(dividerStart, paneStart)
  const end = Math.min(dividerEnd, paneEnd)
  if (end <= start) return null
  return { offset: start - dividerStart, length: end - start }
}

/** The DOM element of the focused pane surface, if one is focused and mounted. */
export function activeSurfaceElement(activeSurfaceId: string | null): HTMLElement | null {
  if (!activeSurfaceId) return null
  return document.querySelector(`[data-surface="${activeSurfaceId}"]`)
}
