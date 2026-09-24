<script lang="ts">
  // An image fitted to the pane, over a checkerboard so transparency reads.
  // Wheel zooms about the cursor, drag pans, double-click toggles between fit
  // and actual pixels. Zoom is kept as a factor of the image's natural size.
  import MediaToolbar from './MediaToolbar.svelte'
  import MediaToolButton from './MediaToolButton.svelte'
  import { fitScale, zoomAbout, type ViewTransform } from '../../lib/mediaView'

  let { src }: { src: string } = $props()

  const MIN_SCALE = 0.02
  const MAX_SCALE = 64

  let stageEl = $state<HTMLDivElement>()
  let naturalWidth = $state(0)
  let naturalHeight = $state(0)
  let failed = $state(false)
  // Whether the view follows the pane size; any manual zoom or pan ends it.
  let fitting = $state(true)
  let view = $state<ViewTransform>({ scale: 1, x: 0, y: 0 })
  let drag: { pointerId: number; startX: number; startY: number; originX: number; originY: number } | null =
    null

  // A new source is a new image: forget the old one's size until it loads.
  $effect(() => {
    void src
    failed = false
  })

  /** Takes the loaded image's size and fits it to the stage. */
  function handleLoad(event: Event): void {
    const image = event.currentTarget as HTMLImageElement
    const sizeChanged = image.naturalWidth !== naturalWidth || image.naturalHeight !== naturalHeight
    naturalWidth = image.naturalWidth
    naturalHeight = image.naturalHeight
    // A reload of the same picture keeps the user's zoom; a different size refits.
    if (sizeChanged) fitting = true
    if (fitting) fit()
  }

  /** Scales the image to fit the stage with a margin, centred. */
  function fit(): void {
    if (!stageEl || naturalWidth === 0) return
    const scale = fitScale(naturalWidth, naturalHeight, stageEl.clientWidth, stageEl.clientHeight)
    view = centred(scale)
    fitting = true
  }

  /** Shows the image at one image pixel per CSS pixel, centred. */
  function actualSize(): void {
    view = centred(1)
    fitting = false
  }

  /** The transform that puts the image at `scale`, centred in the stage. */
  function centred(scale: number): ViewTransform {
    const stageWidth = stageEl?.clientWidth ?? 0
    const stageHeight = stageEl?.clientHeight ?? 0
    return {
      scale,
      x: (stageWidth - naturalWidth * scale) / 2,
      y: (stageHeight - naturalHeight * scale) / 2
    }
  }

  /** Zooms by `factor` about a point in stage coordinates. */
  function zoomAt(factor: number, pointX: number, pointY: number): void {
    view = zoomAbout(view, factor, pointX, pointY, MIN_SCALE, MAX_SCALE)
    fitting = false
  }

  /** Zooms by `factor` about the stage centre (toolbar buttons). */
  function zoomCentre(factor: number): void {
    if (!stageEl) return
    zoomAt(factor, stageEl.clientWidth / 2, stageEl.clientHeight / 2)
  }

  function handleWheel(event: WheelEvent): void {
    if (!stageEl) return
    event.preventDefault()
    const bounds = stageEl.getBoundingClientRect()
    // Trackpad pinches arrive as small ctrl-wheel deltas; a mouse notch is ~100.
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))
    zoomAt(factor, event.clientX - bounds.left, event.clientY - bounds.top)
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y
    }
    stageEl?.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return
    view = {
      scale: view.scale,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY
    }
    fitting = false
  }

  function handlePointerUp(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return
    drag = null
  }

  function handleError(): void {
    failed = true
  }

  function handleDoubleClick(): void {
    if (fitting) {
      actualSize()
      return
    }
    fit()
  }

  // Keep a fitted image fitted as the pane resizes.
  $effect(() => {
    if (!stageEl) return
    const observer = new ResizeObserver(() => {
      if (fitting) fit()
    })
    observer.observe(stageEl)
    return () => observer.disconnect()
  })
</script>

<div
  bind:this={stageEl}
  class="checkerboard relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
  role="img"
  onwheel={handleWheel}
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerUp}
  ondblclick={handleDoubleClick}
>
  {#if failed}
    <div class="flex h-full items-center justify-center text-xs text-dim">
      This image could not be decoded.
    </div>
  {:else}
    <img
      {src}
      alt=""
      draggable="false"
      class="absolute left-0 top-0 max-w-none origin-top-left select-none"
      class:invisible={naturalWidth === 0}
      style:transform="translate({view.x}px, {view.y}px) scale({view.scale})"
      style:image-rendering={view.scale >= 4 ? 'pixelated' : 'auto'}
      onload={handleLoad}
      onerror={handleError}
    />
  {/if}
</div>
<MediaToolbar>
  {#snippet info()}
    {#if naturalWidth > 0}
      {naturalWidth} × {naturalHeight} · {Math.round(view.scale * 100)}%
    {/if}
  {/snippet}
  {#snippet actions()}
    <MediaToolButton title="Zoom out" onclick={() => zoomCentre(1 / 1.25)}>−</MediaToolButton>
    <MediaToolButton title="Zoom in" onclick={() => zoomCentre(1.25)}>+</MediaToolButton>
    <MediaToolButton title="Fit to pane" active={fitting} onclick={fit}>Fit</MediaToolButton>
    <MediaToolButton title="Actual size" onclick={actualSize}>1:1</MediaToolButton>
  {/snippet}
</MediaToolbar>

<style>
  /* Transparent pixels show as the usual two-tone grid, in the theme's own tones. */
  .checkerboard {
    background-color: var(--color-surface);
    background-image:
      linear-gradient(45deg, var(--color-elevated) 25%, transparent 25%),
      linear-gradient(-45deg, var(--color-elevated) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--color-elevated) 75%),
      linear-gradient(-45deg, transparent 75%, var(--color-elevated) 75%);
    background-size: 16px 16px;
    background-position:
      0 0,
      0 8px,
      8px -8px,
      -8px 0;
  }
</style>
