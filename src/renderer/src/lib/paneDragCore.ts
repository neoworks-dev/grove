// Pure geometry for pane drag-and-drop, unit-testable without DOM. Maps a
// pointer position inside a pane's rect to a drop zone, and a zone to the
// placeholder rectangle that previews where the pane will land.

import type { DropZone } from './layoutTree'

// Fraction of each axis, measured from the center, that counts as the middle
// (replace) zone. 0.17 → the central ~34% box on both axes.
const CENTER_HALF = 0.17

// Pointer position (fractions of the rect, 0..1) → drop zone. The middle box
// replaces; otherwise the nearest edge wins.
export function dropZoneAt(fractionX: number, fractionY: number): DropZone {
  const inCenterX = Math.abs(fractionX - 0.5) < CENTER_HALF
  const inCenterY = Math.abs(fractionY - 0.5) < CENTER_HALF
  if (inCenterX && inCenterY) return 'center'

  const toLeft = fractionX
  const toRight = 1 - fractionX
  const toTop = fractionY
  const toBottom = 1 - fractionY
  const nearest = Math.min(toLeft, toRight, toTop, toBottom)
  if (nearest === toLeft) return 'left'
  if (nearest === toRight) return 'right'
  if (nearest === toTop) return 'top'
  return 'bottom'
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

// The placeholder rectangle for a zone within the target's rect: full rect for
// center, the matching half for an edge.
export function placeholderRect(rect: Rect, zone: DropZone): Rect {
  const half = { ...rect }
  if (zone === 'left') return { ...half, width: rect.width / 2 }
  if (zone === 'right') return { ...half, left: rect.left + rect.width / 2, width: rect.width / 2 }
  if (zone === 'top') return { ...half, height: rect.height / 2 }
  if (zone === 'bottom') return { ...half, top: rect.top + rect.height / 2, height: rect.height / 2 }
  return half
}
