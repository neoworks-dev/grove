<script lang="ts">
  // Resize gutter between two siblings of a split. Renders as an empty gap the
  // panes sit apart in — each pane draws its own border, so the gutter only
  // needs to show a handle on hover; drag or arrow keys shift the boundary.
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import PanePicker from './PanePicker.svelte'
  import { layout } from '../lib/layout.svelte'
  import {
    type LayoutNode,
    type SplitNode,
    MIN_PANE_FRACTION,
    clampGutterShift
  } from '../lib/layoutTree'

  let { split, gutterIndex }: { split: SplitNode; gutterIndex: number } = $props()

  const horizontal = $derived(split.direction === 'row')

  // The `+` picker: open a new pane in this gap.
  let pickerOpen = $state(false)
  let menuEl = $state<HTMLDivElement>()

  /** Close the picker when a pointer press lands outside it. */
  function onWindowPointerDown(event: PointerEvent): void {
    if (!pickerOpen) return
    if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return
    pickerOpen = false
  }

  function openPane(paneTypeId: string): void {
    pickerOpen = false
    layout.insertAtGutter(split.id, gutterIndex, paneTypeId)
  }

  // Once a neighbor bottoms out at its min, dragging this many more px past the
  // clamp collapses it — independent of whether a min was set. Subtrees keep
  // clamping; only single leaves disappear.
  const COLLAPSE_SLOP_PX = 40

  let dragging = $state(false)
  let lastPos = 0
  let pxPerFraction = 1
  let rootEl: HTMLElement

  // Pointer moves fire far faster than the display refreshes; accumulate the
  // drag delta and apply it once per animation frame so the tree rebuilds at
  // most once per painted frame instead of on every move event.
  let pendingDelta = 0
  let frame: number | null = null

  // Signed px dragged past the size clamp (resize can't absorb it), and the
  // pane it is pushing against. Past the slop that pane collapses: hidden while
  // the drag is held, closed when it is released.
  let overshoot = 0
  let overshootNode: LayoutNode | null = null

  // The two subtrees this gutter sits between.
  const before = $derived(split.children[gutterIndex])
  const after = $derived(split.children[gutterIndex + 1])

  // Smallest fraction this neighbor may shrink to: its own minimum, not the
  // larger of the two.
  function minFractionOf(node: LayoutNode): number {
    const minPx = layout.minSizePx(node, split.direction)
    return Math.max(MIN_PANE_FRACTION, Math.min(0.45, minPx / pxPerFraction))
  }

  // Pixels one unit of share is worth in this split, read off the two panes the
  // gutter sits between. The container is no basis for it: a fixed-size sibling
  // takes part of the container without holding a share of it.
  function measure(): void {
    const beforeEl = rootEl?.previousElementSibling as HTMLElement | null
    const afterEl = rootEl?.nextElementSibling as HTMLElement | null
    if (!beforeEl || !afterEl) return
    let px = beforeEl.offsetHeight + afterEl.offsetHeight
    if (horizontal) px = beforeEl.offsetWidth + afterEl.offsetWidth
    const fraction = split.sizes[gutterIndex] + split.sizes[gutterIndex + 1]
    if (px <= 0 || fraction <= 0) return
    pxPerFraction = px / fraction
  }

  function onPointerDown(event: PointerEvent): void {
    dragging = true
    setOvershoot(0, null)
    lastPos = horizontal ? event.clientX : event.clientY
    measure()
    event.preventDefault()
    // Captured, so the release still arrives when the pointer has left the
    // window — a collapsing pane is only closed or restored on it.
    capturePointer(event)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  }

  /** Captures the dragging pointer; one that is not active (synthetic) has nothing to capture. */
  function capturePointer(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // Not an active pointer: the window listeners still see its moves.
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    const pos = horizontal ? event.clientX : event.clientY
    pendingDelta += pos - lastPos
    lastPos = pos
    if (frame === null) frame = requestAnimationFrame(flushResize)
  }

  function flushResize(): void {
    frame = null
    if (pendingDelta === 0) return
    const delta = pendingDelta
    pendingDelta = 0
    applyDelta(delta)
  }

  // A pane that holds a size owns the boundary next to it: the drag changes its
  // pixels and its siblings absorb the difference. Only when neither side holds
  // one do the two shares move against each other.
  function applyDelta(requestedDelta: number): void {
    const delta = unwindOvershoot(requestedDelta)
    if (delta === 0) return
    const beforePx = layout.fixedSizePx(before)
    const afterPx = layout.fixedSizePx(after)
    if (beforePx === null && afterPx === null) {
      resizeShares(delta)
      return
    }
    if (beforePx !== null) resizeFixed(before, beforePx, beforePx + delta)
    if (afterPx !== null) resizeFixed(after, afterPx, afterPx - delta)
  }

  /**
   * Spends a drag back toward a squeezed pane on the overshoot first, so
   * pulling back retraces the drag — un-collapsing the pane on the way — before
   * it starts growing. Returns what is left of the delta for resizing.
   */
  function unwindOvershoot(delta: number): number {
    if (overshoot === 0 || Math.sign(delta) === Math.sign(overshoot)) return delta
    const unwound = overshoot + delta
    if (Math.sign(unwound) === Math.sign(overshoot)) {
      setOvershoot(unwound, overshootNode)
      return 0
    }
    setOvershoot(0, null)
    return unwound
  }

  /** Adds drag the clamp could not absorb against `node`; a reversal starts the count over. */
  function addOvershoot(leftoverPx: number, node: LayoutNode): void {
    let total = leftoverPx
    if (Math.sign(leftoverPx) === Math.sign(overshoot)) total += overshoot
    setOvershoot(total, node)
  }

  /** Records the overshoot, and hides its pane once it passes the slop. */
  function setOvershoot(amount: number, node: LayoutNode | null): void {
    overshoot = amount
    overshootNode = node
    if (amount === 0) overshootNode = null
    let collapsingLeafId: string | null = null
    if (overshootNode?.kind === 'leaf' && Math.abs(overshoot) > COLLAPSE_SLOP_PX) {
      collapsingLeafId = overshootNode.id
    }
    layout.collapsingLeafId = collapsingLeafId
  }

  // Commit a fixed pane's new size, stopped at its minimum — or at its current
  // size, when the layout already squeezed it under that. Drag the stop can't
  // absorb piles up as overshoot.
  function resizeFixed(node: LayoutNode, currentPx: number, requestedPx: number): void {
    const floorPx = Math.min(layout.minSizePx(node, split.direction), currentPx)
    const clamped = Math.max(floorPx, requestedPx)
    layout.setFixedSizePx(node.id, clamped)
    const leftover = requestedPx - clamped
    if (leftover === 0) {
      setOvershoot(0, null)
      return
    }
    addOvershoot(leftover, node)
  }

  // Move the boundary between two panes that share the container.
  function resizeShares(delta: number): void {
    const beforeFraction = split.sizes[gutterIndex]
    const afterFraction = split.sizes[gutterIndex + 1]
    const minBefore = minFractionOf(before)
    const minAfter = minFractionOf(after)
    // What resizeGutter will actually apply after clamping each side to its min.
    const requested = delta / pxPerFraction
    const clamped = clampGutterShift(requested, beforeFraction, afterFraction, minBefore, minAfter)
    const leftoverPx = (requested - clamped) * pxPerFraction
    if (leftoverPx === 0) setOvershoot(0, null)
    // leftover > 0 squeezes the right child; < 0 the left one.
    if (leftoverPx > 0) addOvershoot(leftoverPx, after)
    if (leftoverPx < 0) addOvershoot(leftoverPx, before)
    if (clamped !== 0) layout.resize(split.id, gutterIndex, clamped, minBefore, minAfter)
  }

  /** Closes the pane the drag left collapsed, if any, and clears the overshoot. */
  function commitCollapse(): void {
    const leafId = layout.collapsingLeafId
    setOvershoot(0, null)
    if (leafId) layout.closeLeaf(leafId)
  }

  function endDrag(): void {
    dragging = false
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerCancel)
  }

  function onPointerUp(): void {
    flushResize()
    endDrag()
    commitCollapse()
  }

  // The system took the pointer away mid-drag: nobody chose to close the pane,
  // so a collapsing one comes back.
  function onPointerCancel(): void {
    endDrag()
    setOvershoot(0, null)
  }

  // Keyboard resize for accessibility. There is no drag to release, so a pane
  // pushed past its collapse point closes straight away.
  function onKeyDown(event: KeyboardEvent): void {
    const grow = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const shrink = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    if (!grow && !shrink) return
    event.preventDefault()
    measure()
    applyDelta(grow ? 24 : -24)
    if (layout.collapsingLeafId) commitCollapse()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  bind:this={rootEl}
  data-gutter="{split.id}:{gutterIndex}"
  class="group/gutter relative shrink-0 {horizontal ? 'w-2' : 'h-2'}"
  role="separator"
  aria-orientation={horizontal ? 'vertical' : 'horizontal'}
>
  <!-- Invisible hit zone wider than the gap so the gutter stays easy to grab;
       the visible handle is the thin centered bar inside it. -->
  <div
    class="absolute z-raised {horizontal
      ? '-left-1 -right-1 top-0 h-full cursor-col-resize'
      : '-top-1 -bottom-1 left-0 w-full cursor-row-resize'}"
    role="separator"
    aria-orientation={horizontal ? 'vertical' : 'horizontal'}
    tabindex="0"
    onpointerdown={onPointerDown}
    onkeydown={onKeyDown}
  >
    <div
      class="absolute rounded-full transition-colors {horizontal
        ? 'inset-y-0 left-1/2 w-0.5 -translate-x-1/2'
        : 'inset-x-0 top-1/2 h-0.5 -translate-y-1/2'} {dragging
        ? 'bg-accent'
        : 'bg-transparent group-hover/gutter:bg-line-strong'}"
    ></div>
  </div>

  <!-- Open a pane in this gap. Sits above the drag hit zone and swallows its
       own pointerdown, so pressing it never starts a resize. -->
  {#if !dragging}
    <div
      bind:this={menuEl}
      class="absolute left-1/2 top-1/2 z-overlay -translate-x-1/2 -translate-y-1/2"
    >
      <button
        class="flex h-5 w-5 items-center justify-center rounded-full border border-line bg-elevated text-dim opacity-0 transition-opacity duration-100 hover:text-default group-hover/gutter:opacity-100"
        class:opacity-100={pickerOpen}
        title="Open a pane here"
        aria-label="Open a pane here"
        onpointerdown={(event) => event.stopPropagation()}
        onclick={() => (pickerOpen = !pickerOpen)}
      >
        <PlusIcon size={11} weight="bold" />
      </button>
      {#if pickerOpen}
        <div class="absolute left-1/2 top-6 -translate-x-1/2">
          <PanePicker onpick={openPane} />
        </div>
      {/if}
    </div>
  {/if}
</div>
