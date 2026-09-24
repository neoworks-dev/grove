// How much of a scrolled row of tabs lies out of view, and which tab to bring
// in next. Kept apart from the tab strip so it is testable without a DOM.

/** A tab's horizontal extent within the scrolled row, in pixels. */
export interface TabSpan {
  start: number
  end: number
}

/** How many tabs lie at least partly out of view on each side. */
export interface TabOverflow {
  left: number
  right: number
}

// Sub-pixel layout leaves a tab flush with the edge a fraction over it.
const EDGE_TOLERANCE = 1

/** Counts the tabs cut off by the view between `viewStart` and `viewEnd`. */
export function tabOverflow(
  spans: readonly TabSpan[],
  viewStart: number,
  viewEnd: number
): TabOverflow {
  let left = 0
  let right = 0
  for (const span of spans) {
    if (span.start < viewStart - EDGE_TOLERANCE) left += 1
    if (span.end > viewEnd + EDGE_TOLERANCE) right += 1
  }
  return { left, right }
}

/**
 * The index of the nearest tab cut off on `side` — the one to reveal next —
 * or -1 when that side is fully in view.
 */
export function nextHiddenTab(
  spans: readonly TabSpan[],
  viewStart: number,
  viewEnd: number,
  side: 'left' | 'right'
): number {
  if (side === 'left') {
    return lastIndexWhere(spans, (span) => span.start < viewStart - EDGE_TOLERANCE)
  }
  return spans.findIndex((span) => span.end > viewEnd + EDGE_TOLERANCE)
}

/** The last index whose span passes `test`, or -1. */
function lastIndexWhere(spans: readonly TabSpan[], test: (span: TabSpan) => boolean): number {
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    if (test(spans[index])) return index
  }
  return -1
}
