<script lang="ts">
  // One page of a PdfViewer. Its box is sized from the page straight away; the
  // canvas and the selectable text over it are only drawn once the page comes
  // near the view, and redrawn at the new resolution after a zoom. The new
  // drawing replaces the old one only when it is finished, so a zoom scales the
  // old bitmap for a moment instead of flashing blank.
  import { TextLayer, type PDFPageProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'

  let { page, scale, root }: { page: PDFPageProxy; scale: number; root: HTMLElement | undefined } =
    $props()

  // Pages this far outside the view render ahead of being scrolled to.
  const PRELOAD_MARGIN = '600px 0px'

  let boxEl = $state<HTMLDivElement>()
  let canvasHostEl = $state<HTMLDivElement>()
  let textHostEl = $state<HTMLDivElement>()
  let visible = $state(false)

  const viewport = $derived(page.getViewport({ scale }))

  $effect(() => {
    if (!boxEl || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible = entry.isIntersecting
      },
      { root, rootMargin: PRELOAD_MARGIN }
    )
    observer.observe(boxEl)
    return () => observer.disconnect()
  })

  $effect(() => {
    if (!visible || !canvasHostEl || !textHostEl) return
    const task = drawPage(viewport.scale, canvasHostEl, textHostEl)
    return () => task.cancel()
  })

  /** Draws the page at `pageScale` into fresh elements, then swaps them in. */
  function drawPage(
    pageScale: number,
    canvasHost: HTMLElement,
    textHost: HTMLElement
  ): { cancel: () => void } {
    const pixelRatio = window.devicePixelRatio || 1
    const canvasViewport = page.getViewport({ scale: pageScale * pixelRatio })
    const textViewport = page.getViewport({ scale: pageScale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(canvasViewport.width)
    canvas.height = Math.floor(canvasViewport.height)
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'

    const textLayerEl = document.createElement('div')
    textLayerEl.className = 'textLayer'
    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerEl,
      viewport: textViewport
    })

    const renderTask: RenderTask = page.render({ canvas, viewport: canvasViewport })
    Promise.all([renderTask.promise, textLayer.render()])
      .then(() => {
        canvasHost.replaceChildren(canvas)
        textHost.replaceChildren(textLayerEl)
      })
      .catch(() => {
        // Cancelled by a newer zoom or by scrolling away; nothing to show.
      })

    return {
      cancel: () => {
        renderTask.cancel()
        textLayer.cancel()
      }
    }
  }
</script>

<!-- The scale variables are what pdf.js's text layer sizes its spans by;
     its own viewer sets them on `.pdfViewer .page`, which this doesn't use. -->
<div
  bind:this={boxEl}
  class="relative shrink-0 bg-white shadow-lg"
  style:width="{viewport.width}px"
  style:height="{viewport.height}px"
  style:--scale-factor={viewport.scale}
  style:--user-unit={1}
  style:--total-scale-factor="calc(var(--scale-factor) * var(--user-unit))"
  style:--scale-round-x="1px"
  style:--scale-round-y="1px"
>
  <div bind:this={canvasHostEl} class="absolute inset-0"></div>
  <div bind:this={textHostEl} class="absolute inset-0"></div>
</div>
