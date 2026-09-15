<script lang="ts">
  // Resize gutter between two siblings of a split. Renders as an empty gap the
  // panes sit apart in — each pane draws its own border, so the gutter only
  // needs to show a handle on hover; drag or arrow keys shift the boundary.
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import PanePicker from './PanePicker.svelte'
  import { layout } from '../lib/layout.svelte'
  import { type LayoutNode, type SplitNode, MIN_PANE_FRACTION } from '../lib/layoutTree'

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

  // The two subtrees this gutter sits between.
  const before = $derived(split.children[gutterIndex])
  const after = $derived(split.children[gutterIndex + 1])

  // Smallest fraction either neighbor may shrink to.
  function minFraction(): number {
    const minPx = Math.max(
      layout.minSizePx(before, split.direction),
      layout.minSizePx(after, split.direction)
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
    applyDelta(delta)
  }

  // A pane that holds a size owns the boundary next to it: the drag changes its
  // pixels and its siblings absorb the difference. Only when neither side holds
  // one do the two shares move against each other.
  function applyDelta(delta: number): void {
    const beforePx = layout.fixedSizePx(before)
    const afterPx = layout.fixedSizePx(after)
    if (beforePx === null && afterPx === null) {
      resizeShares(delta)
      return
    }
    if (beforePx !== null) resizeFixed(before, beforePx + delta)
    if (afterPx !== null) resizeFixed(after, afterPx - delta)
  }

  // Commit a fixed pane's new size, stopped at its minimum. Drag the stop can't
  // absorb piles up as overshoot, and past the slop the pane closes.
  function resizeFixed(node: LayoutNode, requestedPx: number): void {
    const clamped = Math.max(layout.minSizePx(node, split.direction), requestedPx)
    layout.setFixedSizePx(node.id, clamped)
    const leftover = requestedPx - clamped
    if (leftover === 0) {
      overshoot = 0
      return
    }
    if (Math.sign(leftover) !== Math.sign(overshoot)) overshoot = 0
    overshoot += leftover
    if (node.kind !== 'leaf' || Math.abs(overshoot) <= COLLAPSE_SLOP_PX) return
    endDrag()
    layout.closeLeaf(node.id)
  }

  // Move the boundary between two panes that share the container.
  function resizeShares(delta: number): void {
    const beforeFraction = split.sizes[gutterIndex]
    const afterFraction = split.sizes[gutterIndex + 1]
    const minFrac = minFraction()
    // What resizeGutter will actually apply after clamping both sides to min.
    const requested = delta / containerPx
    const clamped = Math.min(Math.max(requested, minFrac - beforeFraction), afterFraction - minFrac)
    const leftoverPx = (requested - clamped) * containerPx
    if (leftoverPx !== 0 && collapseSqueezed(leftoverPx)) return
    if (leftoverPx === 0) overshoot = 0
    if (clamped !== 0) layout.resize(split.id, gutterIndex, clamped, minFrac)
  }

  // Track drag the clamp couldn't absorb; past the slop the squeezed pane
  // closes. Returns whether it did. A reversal resets the count.
  function collapseSqueezed(leftoverPx: number): boolean {
    if (Math.sign(leftoverPx) !== Math.sign(overshoot)) overshoot = 0
    overshoot += leftoverPx
    // leftover > 0 squeezes the right child; < 0 the left one.
    const squeezed = overshoot > 0 ? after : before
    if (squeezed?.kind !== 'leaf' || Math.abs(overshoot) <= COLLAPSE_SLOP_PX) return false
    endDrag()
    layout.closeLeaf(squeezed.id)
    return true
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
    applyDelta(grow ? 24 : -24)
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  bind:this={rootEl}
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
