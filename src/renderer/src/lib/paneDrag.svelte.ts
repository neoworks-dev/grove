// Alt+drag pane relocation. Tracks the dragged leaf and the current drop target
// (leaf + zone) as the pointer moves, so the overlay can preview the landing
// spot; on release it commits the move through the layout store.
//
// Frames (plugin pages, file viewers) are separate
// documents: pointer events over them never reach this one, so neither the
// leaf's Alt+pointerdown nor the drag's pointermove would fire there. While Alt
// is held or a drag runs, the root carries `data-pane-drag` and CSS makes every
// frame click-through, so the gesture lands on the leaf underneath.

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
  private altHeld = false

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
    this.syncFramePassThrough()
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    window.addEventListener('keydown', this.onKeyDown)
  }

  /**
   * Follows the Alt key so frames turn click-through before the press lands.
   * A page forwards its unhandled keydowns, so Alt pressed inside a frame is
   * seen too; its keyup is not, so any pointer event without Alt (which reaches
   * this document once frames are click-through) or losing window focus clears
   * it. Returns the inverse.
   */
  watchAltKey(): () => void {
    const onKey = (event: KeyboardEvent): void => this.setAltHeld(event.altKey)
    const onPointer = (event: PointerEvent): void => this.setAltHeld(event.altKey)
    const onBlur = (): void => this.setAltHeld(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('pointermove', onPointer, true)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('pointermove', onPointer, true)
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', onBlur)
      this.setAltHeld(false)
    }
  }

  /** Records whether Alt is down and updates frame pass-through to match. */
  private setAltHeld(held: boolean): void {
    if (this.altHeld === held) return
    this.altHeld = held
    this.syncFramePassThrough()
  }

  /** Marks the root so CSS makes frames click-through while Alt is held or a drag runs. */
  private syncFramePassThrough(): void {
    const root = document.documentElement
    if (this.altHeld || this.active) {
      root.dataset.paneDrag = ''
    } else {
      delete root.dataset.paneDrag
    }
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
    this.syncFramePassThrough()
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
