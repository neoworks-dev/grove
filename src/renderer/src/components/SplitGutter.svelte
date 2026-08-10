<script lang="ts">
  // Resize gutter between two siblings of a split. Renders as an empty gap the
  // panes sit apart in — each pane draws its own border, so the gutter only
  // needs to show a handle on hover; drag or arrow keys shift the boundary.
  import { layout } from '../lib/layout.svelte'
  import { panes } from '../lib/panes.svelte'
  import { leaves, type LayoutNode, type SplitNode, MIN_PANE_FRACTION } from '../lib/layoutTree'

  let { split, gutterIndex }: { split: SplitNode; gutterIndex: number } = $props()

  const horizontal = $derived(split.direction === 'row')

  // Once a neighbor bottoms out at its min, dragging this many more px past the
  // clamp collapses (closes) it — mirroring the dock resize, and independent of
  // whether a min was set. Subtrees keep clamping; only single leaves disappear.
  const COLLAPSE_SLOP_PX = 40

  let dragging = $state(false)
  let lastPos = 0
  let containerPx = 1
  let rootEl: HTMLElement

  // Pointer moves fire far faster than the display refreshes; accumulate the
  // drag delta and apply it once per animation frame so the tree rebuilds at
  // most once per painted frame instead of on every move event.
  let pendingDelta = 0
  let frame: number | null = null

  // Signed px dragged past the size clamp (resize can't absorb it). Grows while
  // a bottomed-out neighbor is pushed further; triggers collapse past the slop.
  let overshoot = 0

  // A subtree's minimum pixel extent along this split's axis (default 120px),
  // taken from the largest pane-type minimum among its leaves.
  function minPxFor(node: LayoutNode): number {
    let minPx = 120
    for (const leaf of leaves(node)) {
      const type = panes.get(leaf.paneTypeId)
      const px = horizontal ? type?.minWidth : type?.minHeight
      if (px && px > minPx) minPx = px
    }
    return minPx
  }

  // Smallest fraction either neighbor may shrink to.
  function minFraction(): number {
    const minPx = Math.max(
      minPxFor(split.children[gutterIndex]),
      minPxFor(split.children[gutterIndex + 1])
    )
    return Math.max(MIN_PANE_FRACTION, Math.min(0.45, minPx / containerPx))
  }

  // The split's flex container is the gutter root's parent; its size is the
  // basis for converting pixel drag deltas into size fractions.
  function measure(): void {
    const parent = rootEl?.parentElement
    if (!parent) return
    containerPx = Math.max(1, horizontal ? parent.clientWidth : parent.clientHeight)
  }

  function onPointerDown(event: PointerEvent): void {
    dragging = true
    overshoot = 0
    lastPos = horizontal ? event.clientX : event.clientY
    measure()
    event.preventDefault()
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
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
    const before = split.sizes[gutterIndex]
    const after = split.sizes[gutterIndex + 1]
    const minFrac = minFraction()
    // What resizeGutter will actually apply after clamping both sides to min.
    const requested = delta / containerPx
    const clamped = Math.min(Math.max(requested, minFrac - before), after - minFrac)
    const leftoverPx = (requested - clamped) * containerPx

    // Drag the clamp can't absorb accumulates as overshoot; a reversal resets it.
    if (leftoverPx !== 0) {
      if (Math.sign(leftoverPx) !== Math.sign(overshoot)) overshoot = 0
      overshoot += leftoverPx
      // leftover > 0 squeezes the right child; < 0 the left one.
      const shrinkIndex = overshoot > 0 ? gutterIndex + 1 : gutterIndex
      const child = split.children[shrinkIndex]
      if (child?.kind === 'leaf' && Math.abs(overshoot) > COLLAPSE_SLOP_PX) {
        endDrag()
        layout.closeLeaf(child.id)
        return
      }
    } else {
      overshoot = 0
    }

    if (clamped !== 0) layout.resize(split.id, gutterIndex, clamped, minFrac)
  }

  function endDrag(): void {
    dragging = false
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  }

  function onPointerUp(): void {
    flushResize()
    endDrag()
  }

  // Keyboard resize for accessibility.
  function onKeyDown(event: KeyboardEvent): void {
    const grow = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const shrink = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    if (!grow && !shrink) return
    event.preventDefault()
    measure()
    const deltaPx = grow ? 24 : -24
    layout.resize(split.id, gutterIndex, deltaPx / containerPx, minFraction())
  }
</script>

<div
  bind:this={rootEl}
  class="relative shrink-0 {horizontal ? 'w-2' : 'h-2'}"
  role="separator"
  aria-orientation={horizontal ? 'vertical' : 'horizontal'}
>
  <!-- Invisible hit zone wider than the gap so the gutter stays easy to grab;
       the visible handle is the thin centered bar inside it. -->
  <div
    class="group absolute z-raised {horizontal
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
        : 'bg-transparent group-hover:bg-line-strong'}"
    ></div>
  </div>
</div>
