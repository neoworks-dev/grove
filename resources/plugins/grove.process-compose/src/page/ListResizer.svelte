<script lang="ts">
  // The handle on the process list's right edge. Dragging resizes the list
  // live; the width is stored once the drag ends, so it survives a restart.
  // Double-click goes back to the default width.
  import { projectState } from './project.svelte'

  let {
    width,
    onresize
  }: {
    width: number
    // Called with each width while dragging.
    onresize: (width: number) => void
  } = $props()

  const MIN_WIDTH = 160
  const MAX_WIDTH = 560

  let dragging = $state(false)

  /** Follows the pointer until it is released, then stores the width. */
  function startDrag(event: PointerEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    dragging = true
    const startX = event.clientX
    const startWidth = width
    let current = startWidth

    const onMove = (moveEvent: PointerEvent): void => {
      current = clamp(startWidth + moveEvent.clientX - startX)
      onresize(current)
    }
    const onUp = (): void => {
      dragging = false
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      projectState.setPrefs({ listWidth: current })
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }

  /** Keeps a width within what leaves both sides usable. */
  function clamp(value: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
  }

  /** Back to the default width. */
  function reset(): void {
    projectState.setPrefs({ listWidth: null })
  }
</script>

<div
  class="absolute top-0 -right-1 bottom-0 z-10 w-2 cursor-col-resize"
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize the process list"
  title="Drag to resize, double-click to reset"
  onpointerdown={startDrag}
  ondblclick={reset}
>
  <div
    class="mx-auto h-full w-px transition-colors"
    class:bg-primary={dragging}
    class:hover:bg-line-strong={!dragging}
  ></div>
</div>
