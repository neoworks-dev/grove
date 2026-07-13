<script lang="ts">
  import type { EditorView } from '@codemirror/view'
  import type { ThemePalette } from '../lib/themes'
  import {
    extractLineRuns,
    computeGeometry,
    LINE_PITCH,
    GLYPH_HEIGHT,
    COL_WIDTH,
    type LineRun,
    type MinimapGeometry
  } from '../lib/minimap'

  interface Props {
    view: EditorView
    scroller: HTMLElement
    // Bumped by the owner whenever the document (or its highlighting) changed;
    // triggers re-extraction of the colored line runs.
    revision: number
    theme: { palette: ThemePalette; scheme: 'dark' | 'light' }
    class?: string
  }

  let { view, scroller, revision, theme, class: className = '' }: Props = $props()

  let canvas = $state<HTMLCanvasElement>()
  let canvasWidth = $state(0)
  let canvasHeight = $state(0)
  let scrollTop = $state(0)
  let scrollHeight = $state(1)
  let clientHeight = $state(1)
  let hoveringEditor = $state(false)
  let hoveringMap = $state(false)
  let dragging = $state(false)

  // Extracted runs are plain data; the extraction effect schedules its own
  // redraw (a $state version here would be a read-write self-loop).
  let lineRuns: LineRun[][] = []

  let rafId = 0
  let dragStartY = 0
  let dragStartScrollTop = 0

  function measureScroll(): void {
    scrollTop = scroller.scrollTop
    scrollHeight = scroller.scrollHeight
    clientHeight = scroller.clientHeight
  }

  function measureCanvas(): void {
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvasWidth = canvas.clientWidth
    canvasHeight = canvas.clientHeight
    canvas.width = Math.round(canvasWidth * dpr)
    canvas.height = Math.round(canvasHeight * dpr)
  }

  // Re-extract runs when the document or theme changes.
  $effect(() => {
    void revision
    lineRuns = extractLineRuns(view.state, theme.palette)
    scheduleDraw()
  })

  // Track the editor's scroll geometry and hover state.
  $effect(() => {
    measureScroll()
    const onScroll = (): void => measureScroll()
    const onEnter = (): void => {
      hoveringEditor = true
    }
    const onLeave = (): void => {
      hoveringEditor = false
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('pointerenter', onEnter)
    scroller.addEventListener('pointerleave', onLeave)
    const observer = new ResizeObserver(() => measureScroll())
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('pointerenter', onEnter)
      scroller.removeEventListener('pointerleave', onLeave)
      observer.disconnect()
    }
  })

  // Keep the canvas backing store in sync with its CSS size and DPR.
  $effect(() => {
    if (!canvas) return
    measureCanvas()
    const observer = new ResizeObserver(() => measureCanvas())
    observer.observe(canvas)
    return () => observer.disconnect()
  })

  // Redraw whenever anything the frame depends on changes (rAF-coalesced).
  $effect(() => {
    void scrollTop
    void scrollHeight
    void clientHeight
    void canvasWidth
    void canvasHeight
    void hoveringEditor
    void hoveringMap
    void dragging
    void theme
    scheduleDraw()
  })

  $effect(() => {
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
    }
  })

  function scheduleDraw(): void {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      draw()
    })
  }

  function currentGeometry(): MinimapGeometry {
    return computeGeometry(lineRuns.length, canvasHeight, scrollTop, scrollHeight, clientHeight)
  }

  function draw(): void {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = theme.palette.bg
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)
    const geometry = currentGeometry()
    drawRuns(ctx, geometry)
    if (hoveringEditor || hoveringMap || dragging) drawIndicator(ctx, geometry)
  }

  function drawRuns(ctx: CanvasRenderingContext2D, geometry: MinimapGeometry): void {
    const firstLine = Math.max(0, Math.floor(geometry.mapScrollTop / LINE_PITCH))
    const lastLine = Math.min(
      lineRuns.length - 1,
      Math.ceil((geometry.mapScrollTop + canvasHeight) / LINE_PITCH)
    )
    for (let lineIndex = firstLine; lineIndex <= lastLine; lineIndex++) {
      const y = lineIndex * LINE_PITCH - geometry.mapScrollTop
      drawLineRuns(ctx, lineRuns[lineIndex], y)
    }
  }

  function drawLineRuns(ctx: CanvasRenderingContext2D, runs: LineRun[], y: number): void {
    for (const run of runs) {
      ctx.fillStyle = run.color
      ctx.fillRect(run.fromCol * COL_WIDTH, y, (run.toCol - run.fromCol) * COL_WIDTH, GLYPH_HEIGHT)
    }
  }

  function drawIndicator(ctx: CanvasRenderingContext2D, geometry: MinimapGeometry): void {
    ctx.globalAlpha = dragging ? 0.55 : 0.35
    ctx.fillStyle = theme.palette.surfaceHover
    ctx.fillRect(0, geometry.indicatorTop, canvasWidth, geometry.indicatorHeight)
    ctx.globalAlpha = 1
    if (!dragging) return
    ctx.strokeStyle = theme.palette.borderStrong
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, geometry.indicatorTop + 0.5, canvasWidth - 1, geometry.indicatorHeight - 1)
  }

  function clampScroll(value: number): number {
    return Math.max(0, Math.min(value, scroller.scrollHeight - scroller.clientHeight))
  }

  // Center the viewport on the clicked spot of the map.
  function jumpTo(y: number, geometry: MinimapGeometry): void {
    const docRatio = (y + geometry.mapScrollTop) / Math.max(1, geometry.contentHeight)
    const target = docRatio * scroller.scrollHeight - scroller.clientHeight / 2
    scroller.scrollTop = clampScroll(target)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !canvas) return
    event.preventDefault()
    const geometry = currentGeometry()
    const y = event.clientY - canvas.getBoundingClientRect().top
    const onIndicator =
      y >= geometry.indicatorTop && y <= geometry.indicatorTop + geometry.indicatorHeight
    if (!onIndicator) jumpTo(y, geometry)
    dragging = true
    dragStartY = event.clientY
    dragStartScrollTop = scroller.scrollTop
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    const geometry = currentGeometry()
    const travel = Math.min(geometry.contentHeight, canvasHeight) - geometry.indicatorHeight
    if (travel <= 0) return
    const scrollPerMapPixel = (scroller.scrollHeight - scroller.clientHeight) / travel
    scroller.scrollTop = clampScroll(
      dragStartScrollTop + (event.clientY - dragStartY) * scrollPerMapPixel
    )
  }

  function onPointerUp(): void {
    dragging = false
  }

  // Wheel over the minimap keeps scrolling the editor.
  function onWheel(event: WheelEvent): void {
    event.preventDefault()
    scroller.scrollTop = clampScroll(scroller.scrollTop + event.deltaY)
  }
</script>

<div
  class="relative {className}"
  onpointerenter={() => (hoveringMap = true)}
  onpointerleave={() => (hoveringMap = false)}
>
  <canvas
    bind:this={canvas}
    class="h-full w-full cursor-grab touch-none active:cursor-grabbing"
    aria-label="Document minimap"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onwheel={onWheel}
  ></canvas>
</div>
