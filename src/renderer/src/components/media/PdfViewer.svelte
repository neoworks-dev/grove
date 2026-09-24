<script lang="ts">
  // A PDF as a column of pages, drawn by pdf.js. Every page's box is laid out
  // up front from its size, so the scrollbar is right from the start; a page
  // only renders once it scrolls near the view. Opens fitted to the pane's
  // width; ctrl+wheel and the toolbar zoom.
  import { onDestroy } from 'svelte'
  import {
    getDocument,
    GlobalWorkerOptions,
    type PDFDocumentLoadingTask,
    type PDFDocumentProxy,
    type PDFPageProxy
  } from 'pdfjs-dist/legacy/build/pdf.mjs'
  import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
  import 'pdfjs-dist/web/pdf_viewer.css'
  import MediaToolbar from './MediaToolbar.svelte'
  import MediaToolButton from './MediaToolButton.svelte'
  import PdfPage from './PdfPage.svelte'

  // The legacy build: pdf.js targets the newest Chromium, and calls methods
  // (Map.getOrInsertComputed) that Electron's lags behind; this one polyfills them.
  GlobalWorkerOptions.workerSrc = workerUrl

  let { src }: { src: string } = $props()

  const MIN_SCALE = 0.25
  const MAX_SCALE = 6
  const PAGE_GAP = 16
  const SIDE_PADDING = 24

  let scrollEl = $state<HTMLDivElement>()
  let pages = $state.raw<PDFPageProxy[]>([])
  let scale = $state(1)
  // Whether zoom follows the pane width; any manual zoom ends it.
  let fittingWidth = $state(true)
  let currentPage = $state(1)
  let error = $state<string | null>(null)
  // The task behind the document on screen; destroying it frees the document.
  let loadedTask: PDFDocumentLoadingTask | null = null

  $effect(() => {
    const url = src
    let cancelled = false
    error = null
    const task = getDocument({ url })
    task.promise
      .then(async (document) => {
        if (cancelled) return
        const loaded = await loadPages(document)
        if (cancelled) return
        releaseDocument()
        loadedTask = task
        pages = loaded
        if (fittingWidth) fitWidth()
      })
      .catch((cause: Error) => {
        if (cancelled) return
        error = cause.message
      })
    return () => {
      cancelled = true
      // The shown document outlives its source changing until the next one
      // is ready; anything else is abandoned.
      if (task !== loadedTask) void task.destroy()
    }
  })

  /** Every page proxy of a document, in order. */
  function loadPages(document: PDFDocumentProxy): Promise<PDFPageProxy[]> {
    const requests: Promise<PDFPageProxy>[] = []
    for (let number = 1; number <= document.numPages; number += 1) {
      requests.push(document.getPage(number))
    }
    return Promise.all(requests)
  }

  /** Frees the shown document's worker-side state. */
  function releaseDocument(): void {
    if (loadedTask === null) return
    void loadedTask.destroy()
    loadedTask = null
  }

  /** Scales so the widest page fills the pane's width. */
  function fitWidth(): void {
    if (!scrollEl || pages.length === 0) return
    let widest = 0
    for (const page of pages) {
      widest = Math.max(widest, page.getViewport({ scale: 1 }).width)
    }
    const available = scrollEl.clientWidth - SIDE_PADDING * 2
    scale = clampScale(available / widest)
    fittingWidth = true
  }

  function clampScale(value: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
  }

  /**
   * Zooms by `factor`, keeping the document point at `anchorY` (in the scroll
   * container's viewport) where it is.
   */
  function zoomBy(factor: number, anchorY?: number): void {
    if (!scrollEl) return
    const next = clampScale(scale * factor)
    let anchor = anchorY
    if (anchor === undefined) anchor = scrollEl.clientHeight / 2
    const documentY = scrollEl.scrollTop + anchor
    const applied = next / scale
    scale = next
    fittingWidth = false
    // Page gaps don't scale, so this is close rather than exact.
    requestAnimationFrame(() => {
      if (!scrollEl) return
      scrollEl.scrollTop = documentY * applied - anchor
    })
  }

  function handleWheel(event: WheelEvent): void {
    if (!event.ctrlKey || !scrollEl) return
    event.preventDefault()
    const bounds = scrollEl.getBoundingClientRect()
    zoomBy(Math.exp(-event.deltaY * 0.01), event.clientY - bounds.top)
  }

  /** Tracks which page sits at the top third of the view, for the toolbar. */
  function handleScroll(): void {
    if (!scrollEl) return
    const probe = scrollEl.scrollTop + scrollEl.clientHeight / 3
    let top = PAGE_GAP
    for (let index = 0; index < pages.length; index += 1) {
      top += pages[index].getViewport({ scale }).height + PAGE_GAP
      if (top > probe) {
        currentPage = index + 1
        return
      }
    }
    currentPage = pages.length
  }

  // Keep a width-fitted document fitted as the pane resizes.
  $effect(() => {
    if (!scrollEl) return
    const observer = new ResizeObserver(() => {
      if (fittingWidth) fitWidth()
    })
    observer.observe(scrollEl)
    return () => observer.disconnect()
  })

  onDestroy(releaseDocument)
</script>

<div
  bind:this={scrollEl}
  class="min-h-0 flex-1 overflow-auto bg-canvas"
  onwheel={handleWheel}
  onscroll={handleScroll}
>
  {#if error !== null}
    <div class="flex h-full items-center justify-center text-xs text-dim">
      This PDF could not be opened: {error}
    </div>
  {:else}
    <div class="flex w-max min-w-full flex-col items-center" style:gap="{PAGE_GAP}px" style:padding="{PAGE_GAP}px {SIDE_PADDING}px">
      {#each pages as page (page)}
        <PdfPage {page} {scale} root={scrollEl} />
      {/each}
    </div>
  {/if}
</div>
<MediaToolbar>
  {#snippet info()}
    {#if pages.length > 0}
      Page {currentPage} of {pages.length} · {Math.round(scale * 100)}%
    {/if}
  {/snippet}
  {#snippet actions()}
    <MediaToolButton title="Zoom out" onclick={() => zoomBy(1 / 1.2)}>−</MediaToolButton>
    <MediaToolButton title="Zoom in" onclick={() => zoomBy(1.2)}>+</MediaToolButton>
    <MediaToolButton title="Fit width" active={fittingWidth} onclick={fitWidth}>Fit</MediaToolButton>
  {/snippet}
</MediaToolbar>
