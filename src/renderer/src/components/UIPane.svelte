<script lang="ts">
  import type { Snippet } from 'svelte'

  // Reusable resizable pane. Renders content plus a drag handle on one edge.
  // `side` is the edge the handle sits on: left/right control width, top/bottom
  // control height. E.g. a left-docked sidebar uses side="right" (handle on its
  // right edge). `size` is bindable so callers can persist it.
  let {
    side = 'right',
    size = $bindable(256),
    min = 120,
    max = 900,
    step = 24,
    class: cls = '',
    children
  }: {
    side?: 'left' | 'right' | 'top' | 'bottom'
    size?: number
    min?: number
    max?: number
    step?: number
    class?: string
    children: Snippet
  } = $props()

  const horizontal = $derived(side === 'left' || side === 'right')
  // Handles on the left/top edge grow the pane when dragged toward smaller
  // coordinates, so the delta is inverted.
  const inverted = $derived(side === 'left' || side === 'top')

  let dragging = $state(false)
  let startPos = 0
  let startSize = 0

  function clamp(value: number): number {
    return Math.min(max, Math.max(min, value))
  }

  function onPointerDown(event: PointerEvent): void {
    dragging = true
    startPos = horizontal ? event.clientX : event.clientY
    startSize = size
    event.preventDefault()
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    const pos = horizontal ? event.clientX : event.clientY
    let delta = pos - startPos
    if (inverted) delta = -delta
    size = clamp(startSize + delta)
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
    const dir = (grow ? 1 : -1) * (inverted ? -1 : 1)
    size = clamp(size + dir * step)
  }

  const edgeClass: Record<string, string> = {
    left: 'left-0 top-0 h-full w-1 cursor-col-resize',
    right: 'right-0 top-0 h-full w-1 cursor-col-resize',
    top: 'top-0 left-0 w-full h-1 cursor-row-resize',
    bottom: 'bottom-0 left-0 w-full h-1 cursor-row-resize'
  }
</script>

<div
  class="relative shrink-0 {cls}"
  style={horizontal ? `width:${size}px` : `height:${size}px`}
>
  <div class="h-full w-full overflow-hidden">
    {@render children()}
  </div>

  <div
    class="absolute z-raised {edgeClass[side]} {dragging
      ? 'bg-accent'
      : 'bg-transparent hover:bg-line-strong'}"
    role="separator"
    aria-orientation={horizontal ? 'vertical' : 'horizontal'}
    aria-valuenow={size}
    tabindex="0"
    onpointerdown={onPointerDown}
    onkeydown={onKeyDown}
  ></div>
</div>
