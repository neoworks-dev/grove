<script lang="ts">
  // Minimap for the embedded Neovim pane. nvim has no DOM scroller, so this
  // pulls the buffer text, window view, and treesitter highlight spans over RPC
  // (refreshed when the pane's redraw tick bumps) and drives scrolling by
  // sending winrestview back. Buffer text/colors are only re-fetched when
  // changedtick moves, so plain scrolling stays cheap.
  import {
    LINE_PITCH,
    GLYPH_HEIGHT,
    COL_WIDTH,
    buildLineRuns,
    buildColoredRuns,
    computeGeometry,
    toplineForY,
    clampCursorLine,
    type LineRun,
    type ColorSpan,
    type MinimapGeometry
  } from '../lib/minimap'
  import type { ThemePalette } from '../lib/themes'

  let {
    nvimId,
    tick,
    theme,
    diffMarkers = [],
    class: className = ''
  }: {
    nvimId: string | null
    // Bumped by NvimPane on each redraw flush; triggers a throttled refresh.
    tick: number
    theme: { palette: ThemePalette; scheme: 'dark' | 'light' }
    // Changed-line ranges of the open file (1-based), drawn as a git gutter.
    diffMarkers?: { start: number; count: number; kind: 'add' | 'del' | 'mod' }[]
    class?: string
  } = $props()

  let canvas = $state<HTMLCanvasElement>()
  let canvasWidth = $state(0)
  let canvasHeight = $state(0)
  let hovering = $state(false)
  let dragging = $state(false)

  // Monochrome shape (always available) with treesitter colors drawn on top.
  let baseRuns: LineRun[][] = []
  let colorRuns: LineRun[][] = []
  let total = 1
  let topline = 1
  let botline = 1
  let savedView: Record<string, number> = {}
  let lastTick = -1
  let lastBuf = -1

  let refreshing = false
  let refreshPending = false
  let rafId = 0
  // Pointer offset from the indicator top when a drag begins, so grabbing the
  // handle scrolls relative to the grab point instead of jumping.
  let grabOffset = 0

  interface ViewResult {
    view: Record<string, number>
    tick: number
    bufnr: number
    total: number
    topline: number
    botline: number
    lines?: string[]
    spans?: ColorSpan[][]
  }

  // One round-trip: window view + line count always; buffer text and treesitter
  // colors only when the buffer or its content changed (changedtick is
  // per-buffer, so the buffer number is part of the gate).
  const VIEW_LUA = `
    local prevTick, prevBuf = ...
    local buf = vim.api.nvim_get_current_buf()
    local total = vim.api.nvim_buf_line_count(buf)
    local out = {
      view = vim.fn.winsaveview(),
      tick = vim.b.changedtick,
      bufnr = buf,
      total = total,
      topline = vim.fn.line('w0'),
      botline = vim.fn.line('w$')
    }
    if out.tick == prevTick and out.bufnr == prevBuf then return out end
    out.lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    if total <= 8000 then
      local ok, parser = pcall(vim.treesitter.get_parser, buf)
      if ok and parser then
        local spans = {}
        for i = 1, total do spans[i] = {} end
        local cache = {}
        local function colorFor(group)
          if cache[group] == nil then
            local hl = vim.api.nvim_get_hl(0, { name = group, link = false })
            local fg = hl and hl.fg
            cache[group] = fg and string.format('#%06x', fg) or false
          end
          return cache[group]
        end
        pcall(function()
          -- Parse the whole buffer, not just the visible viewport, so every
          -- line gets highlight captures.
          local trees = parser:parse(true)
          local query = vim.treesitter.query.get(parser:lang(), 'highlights')
          if not query then return end
          for _, tree in ipairs(trees) do
            for id, node in query:iter_captures(tree:root(), buf, 0, total) do
              local srow, scol, erow, ecol = node:range()
              if srow == erow then
                local color = colorFor('@' .. query.captures[id])
                if color then table.insert(spans[srow + 1], { scol, ecol, color }) end
              end
            end
          end
        end)
        out.spans = spans
      end
    end
    return out
  `

  async function refresh(): Promise<void> {
    if (!nvimId) return
    if (refreshing) {
      refreshPending = true
      return
    }
    refreshing = true
    try {
      const result = (await window.workbench.nvim.request(nvimId, 'nvim_exec_lua', [
        VIEW_LUA,
        [lastTick, lastBuf]
      ])) as ViewResult | null
      if (!result) return
      total = result.total
      topline = result.topline
      botline = result.botline
      savedView = result.view
      if (result.lines) {
        baseRuns = buildLineRuns(result.lines, theme.palette.textFaint)
        colorRuns = result.spans ? buildColoredRuns(result.spans) : []
        lastTick = result.tick
        lastBuf = result.bufnr
      }
      scheduleDraw()
    } catch {
      // Session gone mid-request — ignore.
    } finally {
      refreshing = false
      if (refreshPending) {
        refreshPending = false
        void refresh()
      }
    }
  }

  // Refresh on redraw tick (nvim scrolled/edited) and when the session changes.
  $effect(() => {
    void tick
    void nvimId
    void refresh()
  })

  // Repaint when the diff gutter changes (no buffer re-fetch needed).
  $effect(() => {
    void diffMarkers
    scheduleDraw()
  })

  $effect(() => {
    if (!canvas) return
    measureCanvas()
    const observer = new ResizeObserver(() => {
      measureCanvas()
      scheduleDraw()
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  })

  $effect(() => {
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
    }
  })

  function measureCanvas(): void {
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvasWidth = canvas.clientWidth
    canvasHeight = canvas.clientHeight
    canvas.width = Math.round(canvasWidth * dpr)
    canvas.height = Math.round(canvasHeight * dpr)
  }

  function scheduleDraw(): void {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      draw()
    })
  }

  function geometry(): MinimapGeometry {
    return computeGeometry(total, topline, botline, canvasHeight)
  }

  function draw(): void {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    // Slightly transparent backdrop so the editor shows through the minimap.
    ctx.globalAlpha = 0.5
    ctx.fillStyle = theme.palette.bgElevated
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)
    ctx.globalAlpha = 1
    const geo = geometry()
    drawRuns(ctx, baseRuns, geo)
    drawRuns(ctx, colorRuns, geo)
    drawDiffGutter(ctx, geo)
    drawIndicator(ctx, geo)
  }

  // Git gutter down the left edge: added/modified ranges as solid bars, pure
  // deletions as a short tick at the line the removal sits after.
  const GUTTER_WIDTH = 3
  function drawDiffGutter(ctx: CanvasRenderingContext2D, geo: MinimapGeometry): void {
    if (diffMarkers.length === 0) return
    const color = {
      add: theme.palette.ctxGreen,
      del: theme.palette.ctxRed,
      mod: theme.palette.ctxAmber
    }
    for (const marker of diffMarkers) {
      ctx.fillStyle = color[marker.kind]
      if (marker.kind === 'del') {
        const y = (marker.start - 1) * LINE_PITCH - geo.mapScrollTop
        ctx.fillRect(0, y - 1, GUTTER_WIDTH, 2)
        continue
      }
      const y = (marker.start - 1) * LINE_PITCH - geo.mapScrollTop
      ctx.fillRect(0, y, GUTTER_WIDTH, Math.max(LINE_PITCH, 1) * marker.count)
    }
  }

  function drawRuns(ctx: CanvasRenderingContext2D, runs: LineRun[][], geo: MinimapGeometry): void {
    if (runs.length === 0) return
    const firstLine = Math.max(0, Math.floor(geo.mapScrollTop / LINE_PITCH))
    const lastLine = Math.min(runs.length - 1, Math.ceil((geo.mapScrollTop + canvasHeight) / LINE_PITCH))
    for (let lineIndex = firstLine; lineIndex <= lastLine; lineIndex++) {
      const y = lineIndex * LINE_PITCH - geo.mapScrollTop
      for (const run of runs[lineIndex]) {
        ctx.fillStyle = run.color
        ctx.fillRect(run.fromCol * COL_WIDTH, y, (run.toCol - run.fromCol) * COL_WIDTH, GLYPH_HEIGHT)
      }
    }
  }

  // The viewport handle is always visible so it tracks editor scrolling; it just
  // gets more prominent on hover/drag.
  function drawIndicator(ctx: CanvasRenderingContext2D, geo: MinimapGeometry): void {
    ctx.globalAlpha = dragging ? 0.5 : hovering ? 0.32 : 0.18
    ctx.fillStyle = theme.palette.surfaceHover
    ctx.fillRect(0, geo.indicatorTop, canvasWidth, geo.indicatorHeight)
    ctx.globalAlpha = 1
  }

  // Scroll nvim so the viewport top lands at the line under handleTopY, keeping
  // the cursor inside the new view. Applied optimistically for a responsive drag.
  function scrollToHandleTop(handleTopY: number): void {
    if (!nvimId) return
    const geo = geometry()
    const target = toplineForY(handleTopY, geo.mapScrollTop, total)
    const visibleLines = Math.max(1, botline - topline + 1)
    const lnum = clampCursorLine(savedView.lnum ?? target, target, visibleLines, total)
    botline = Math.min(total, target + visibleLines - 1)
    topline = target
    scheduleDraw()
    void window.workbench.nvim.request(nvimId, 'nvim_call_function', [
      'winrestview',
      [{ ...savedView, topline: target, lnum }]
    ])
  }

  function localY(event: PointerEvent): number {
    if (!canvas) return 0
    return event.clientY - canvas.getBoundingClientRect().top
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !canvas) return
    event.preventDefault()
    dragging = true
    const y = localY(event)
    const geo = geometry()
    const onHandle = y >= geo.indicatorTop && y <= geo.indicatorTop + geo.indicatorHeight
    // Grab the handle relative to where it was clicked (no jump); clicking off
    // the handle centers it on the pointer first.
    grabOffset = onHandle ? y - geo.indicatorTop : geo.indicatorHeight / 2
    scrollToHandleTop(y - grabOffset)
    canvas.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    scrollToHandleTop(localY(event) - grabOffset)
  }

  function onPointerUp(): void {
    dragging = false
  }
</script>

<div
  class={className}
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => (hovering = false)}
>
  <canvas
    bind:this={canvas}
    class="h-full w-full cursor-grab touch-none active:cursor-grabbing"
    aria-label="Neovim minimap"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
  ></canvas>
</div>
