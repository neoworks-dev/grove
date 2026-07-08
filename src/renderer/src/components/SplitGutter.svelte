<script lang="ts">
  // Resize gutter between two siblings of a split. Renders as a 1px line with
  // a wider invisible hit area; drag or arrow keys shift the boundary.
  import { layout } from '../lib/layout.svelte'
  import { panes } from '../lib/panes.svelte'
  import { leaves, type SplitNode, MIN_PANE_FRACTION } from '../lib/layoutTree'

  let { split, gutterIndex }: { split: SplitNode; gutterIndex: number } = $props()

  const horizontal = $derived(split.direction === 'row')

  let dragging = $state(false)
  let lastPos = 0
  let containerPx = 1
  let rootEl: HTMLElement

  // Smallest fraction either neighbor may shrink to, from the pane types'
  // pixel minimums inside each subtree (default 120px).
  function minFraction(): number {
    const sides = [split.children[gutterIndex], split.children[gutterIndex + 1]]
    let minPx = 120
    for (const side of sides) {
      for (const leaf of leaves(side)) {
        const type = panes.get(leaf.paneTypeId)
        const px = horizontal ? type?.minWidth : type?.minHeight
        if (px && px > minPx) minPx = px
      }
    }
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
    lastPos = horizontal ? event.clientX : event.clientY
    measure()
    event.preventDefault()
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    const pos = horizontal ? event.clientX : event.clientY
    const deltaPx = pos - lastPos
    lastPos = pos
    layout.resize(split.id, gutterIndex, deltaPx / containerPx, minFraction())
  }

  function onPointerUp(): void {
    dragging = false
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
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
  class="relative shrink-0 {horizontal ? 'w-px' : 'h-px'} bg-line"
  role="separator"
  aria-orientation={horizontal ? 'vertical' : 'horizontal'}
>
  <div
    class="absolute z-raised {horizontal
      ? '-left-0.5 -right-0.5 top-0 h-full cursor-col-resize'
      : '-top-0.5 -bottom-0.5 left-0 w-full cursor-row-resize'} {dragging
      ? 'bg-accent'
      : 'bg-transparent hover:bg-line-strong'}"
    role="separator"
    aria-orientation={horizontal ? 'vertical' : 'horizontal'}
    tabindex="0"
    onpointerdown={onPointerDown}
    onkeydown={onKeyDown}
  ></div>
</div>
