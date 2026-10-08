<script lang="ts">
  // The handle between the list (or board) and the thread. Dragging moves the
  // split live and keeps it once released; double-click puts it back.
  let {
    share,
    paneWidth,
    onresize,
    oncommit,
    onreset
  }: {
    /** The list's share of the pane's width, 0 to 1. */
    share: number
    paneWidth: number
    /** Called with each share while dragging. */
    onresize: (share: number) => void
    /** Called once with the share the drag ended on. */
    oncommit: (share: number) => void
    onreset: () => void
  } = $props()

  // Neither side is squeezed below a fifth of the pane.
  const MIN_SHARE = 0.2
  const MAX_SHARE = 0.8

  let dragging = $state(false)

  /** Follows the pointer until it is released, then keeps the share. */
  function startDrag(event: PointerEvent): void {
    if (event.button !== 0 || paneWidth <= 0) return
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    dragging = true
    const startX = event.clientX
    const startShare = share
    let current = startShare

    const onMove = (moveEvent: PointerEvent): void => {
      current = clamp(startShare + (moveEvent.clientX - startX) / paneWidth)
      onresize(current)
    }
    const onUp = (): void => {
      dragging = false
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      oncommit(current)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }

  /** Keeps a share within what leaves both sides usable. */
  function clamp(value: number): number {
    return Math.min(MAX_SHARE, Math.max(MIN_SHARE, value))
  }
</script>

<div
  class="group absolute -right-1 bottom-0 top-0 z-10 w-2 cursor-col-resize"
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize the list and the thread"
  title="Drag to resize, double-click to reset"
  onpointerdown={startDrag}
  ondblclick={onreset}
>
  <div
    class="mx-auto h-full w-px transition-colors group-hover:bg-line-strong"
    class:bg-line-strong={dragging}
  ></div>
</div>
