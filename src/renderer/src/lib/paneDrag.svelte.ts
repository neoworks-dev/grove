// Alt+drag pane relocation. Tracks the dragged leaf and the current drop target
// (leaf + zone) as the pointer moves, so the overlay can preview the landing
// spot; on release it commits the move through the layout store.

import { layout } from './layout.svelte'
import { dropZoneAt, type Rect } from './paneDragCore'
import type { DropZone } from './layoutTree'

export interface DropTarget {
  leafId: string
  zone: DropZone
  rect: Rect
}

class PaneDrag {
  draggedLeafId = $state<string | null>(null)
  pointerX = $state(0)
  pointerY = $state(0)
  target = $state<DropTarget | null>(null)

  get active(): boolean {
    return this.draggedLeafId !== null
  }

  // Begin dragging a leaf. Caller passes the pane's leaf id and the initiating
  // pointer event (already known to hold Alt).
  start(leafId: string, event: PointerEvent): void {
    this.draggedLeafId = leafId
    this.pointerX = event.clientX
    this.pointerY = event.clientY
    this.target = this.resolveTarget(event.clientX, event.clientY)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    window.addEventListener('keydown', this.onKeyDown)
  }

  private onMove = (event: PointerEvent): void => {
    if (!this.active) return
    this.pointerX = event.clientX
    this.pointerY = event.clientY
    this.target = this.resolveTarget(event.clientX, event.clientY)
  }

  private onUp = (): void => {
    const draggedLeafId = this.draggedLeafId
    const target = this.target
    this.stop()
    if (!draggedLeafId || !target) return
    layout.moveLeaf(draggedLeafId, target.leafId, target.zone)
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.stop()
  }

  private stop(): void {
    this.draggedLeafId = null
    this.target = null
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('keydown', this.onKeyDown)
  }

  // Hit-test the leaf under the pointer and derive its drop zone. The overlay is
  // pointer-transparent, so elementFromPoint returns the pane beneath it.
  private resolveTarget(clientX: number, clientY: number): DropTarget | null {
    const element = document.elementFromPoint(clientX, clientY)
    const leafEl = element?.closest('[data-leaf]') as HTMLElement | null
    if (!leafEl) return null
    const leafId = leafEl.dataset.leaf
    if (!leafId) return null
    const bounds = leafEl.getBoundingClientRect()
    if (bounds.width < 1 || bounds.height < 1) return null
    const fractionX = (clientX - bounds.left) / bounds.width
    const fractionY = (clientY - bounds.top) / bounds.height
    const zone = dropZoneAt(fractionX, fractionY)
    const rect: Rect = {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height
    }
    return { leafId, zone, rect }
  }
}

export const paneDrag = new PaneDrag()
