// The zoom-and-pan arithmetic behind the image and PDF viewers, kept apart
// from the components so it can be tested without a DOM.

/** Where a zoomable surface sits in its stage: scale, then offset in CSS pixels. */
export interface ViewTransform {
  scale: number
  x: number
  y: number
}

// Space left around a fitted image so its edge doesn't touch the pane's.
const FIT_MARGIN = 24

/**
 * The scale that fits content of the given size inside the stage with a margin.
 * Never enlarges past actual size: a 16px icon shown at 400% looks broken, not
 * fitted.
 */
export function fitScale(
  contentWidth: number,
  contentHeight: number,
  stageWidth: number,
  stageHeight: number
): number {
  if (contentWidth <= 0 || contentHeight <= 0) return 1
  const availableWidth = Math.max(1, stageWidth - FIT_MARGIN * 2)
  const availableHeight = Math.max(1, stageHeight - FIT_MARGIN * 2)
  const scale = Math.min(availableWidth / contentWidth, availableHeight / contentHeight)
  return Math.min(scale, 1)
}

/**
 * Zooms `view` by `factor` so the content point under (pointX, pointY) stays
 * under it, with the resulting scale held within [minScale, maxScale].
 */
export function zoomAbout(
  view: ViewTransform,
  factor: number,
  pointX: number,
  pointY: number,
  minScale: number,
  maxScale: number
): ViewTransform {
  const scale = Math.min(maxScale, Math.max(minScale, view.scale * factor))
  const applied = scale / view.scale
  return {
    scale,
    x: pointX - (pointX - view.x) * applied,
    y: pointY - (pointY - view.y) * applied
  }
}
