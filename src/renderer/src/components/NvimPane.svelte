<script lang="ts">
  // Embedded Neovim editor: a canvas-rendered ext_linegrid UI bound to a
  // vendored `nvim --embed` sidecar in main. Keys are encoded to vim
  // notation and forwarded; nvim reports modes back which feed the keymap
  // gate exactly like the CodeMirror editor pane.
  import { onMount, onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { keymap } from '../lib/keymap.svelte'
  import { settings } from '../lib/settings.svelte'
  import { createGridState } from '../lib/nvim/types'
  import { applyRedraw } from '../lib/nvim/grid'
  import { encodeKeyEvent } from '../lib/nvim/keys'
  import { measureCell, type CellMetrics, type FontSpec } from '../lib/nvim/metrics'
  import { CanvasGridRenderer } from '../lib/nvim/canvasRenderer'
  import type { GridRenderer } from '../lib/nvim/renderer'

  let { leafId }: { leafId: string } = $props()

  let hostEl = $state<HTMLDivElement>()
  let canvasEl = $state<HTMLCanvasElement>()
  // Hidden contenteditable rather than a textarea: it receives keydown and
  // IME composition, but does not trip the keymap's INPUT/TEXTAREA guard, so
  // the space leader still works while nvim is in normal mode.
  let inputEl = $state<HTMLDivElement>()
  let unavailable = $state(false)

  let nvimId: string | null = null
  let stopRedraw: (() => void) | null = null
  let stopExit: (() => void) | null = null
  let observer: ResizeObserver | null = null
  let renderer: GridRenderer | null = null
  let metrics: CellMetrics | null = null
  let font: FontSpec | null = null

  const grid = createGridState()
  let renderScheduled = false
  let pendingDirtyRows = new Set<number>()
  let pendingDirtyAll = false
  let lastPushedPath: string | null = null
  let composing = false

  function cssVar(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  }

  // Grove → nvim mode names, clamped to what the pane registered.
  function mapMode(name: string): string {
    if (name.startsWith('cmdline')) return 'cmdline'
    if (name === 'select' || name.startsWith('visual')) return 'visual'
    if (name === 'showmatch') return 'insert'
    if (name === 'operator') return 'operator'
    const known = ['normal', 'insert', 'visual', 'replace', 'terminal']
    if (known.includes(name)) return name
    return 'normal'
  }

  function gridSize(): { cols: number; rows: number } {
    if (!hostEl || !metrics) return { cols: 80, rows: 24 }
    return {
      cols: Math.max(2, Math.floor(hostEl.clientWidth / metrics.cellWidth)),
      rows: Math.max(2, Math.floor(hostEl.clientHeight / metrics.cellHeight))
    }
  }

  function scheduleRender(): void {
    if (renderScheduled) return
    renderScheduled = true
    requestAnimationFrame(() => {
      renderScheduled = false
      if (!renderer) return
      renderer.render(grid, {
        all: pendingDirtyAll,
        rows: pendingDirtyRows,
        flushed: true
      })
      pendingDirtyAll = false
      pendingDirtyRows = new Set()
    })
  }

  function handleRedraw(events: unknown[]): void {
    const dirty = applyRedraw(grid, events)
    if (dirty.all) pendingDirtyAll = true
    for (const row of dirty.rows) pendingDirtyRows.add(row)
    keymap.setPaneMode(leafId, mapMode(grid.modeName))
    // Cursor moves without row edits still need a repaint.
    pendingDirtyRows.add(grid.cursor.row)
    if (dirty.flushed || dirty.all) scheduleRender()
  }

  // Coalesced resize → nvim_ui_try_resize (nvim answers with grid_resize).
  let fitScheduled = false
  let lastWidth = 0
  let lastHeight = 0

  function scheduleFit(): void {
    if (fitScheduled) return
    fitScheduled = true
    requestAnimationFrame(() => {
      fitScheduled = false
      if (!hostEl || !nvimId || !renderer) return
      const width = hostEl.clientWidth
      const height = hostEl.clientHeight
      if (width < 2 || height < 2) return
      if (width === lastWidth && height === lastHeight) return
      lastWidth = width
      lastHeight = height
      const { cols, rows } = gridSize()
      renderer.resize(cols, rows, window.devicePixelRatio)
      pendingDirtyAll = true
      void window.workbench.nvim.resize(nvimId, cols, rows)
    })
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!nvimId || composing) return
    const keys = encodeKeyEvent(event)
    if (!keys) return
    event.preventDefault()
    event.stopPropagation()
    void window.workbench.nvim.input(nvimId, keys)
  }

  function handleComposition(event: CompositionEvent): void {
    if (event.type === 'compositionstart') {
      composing = true
      return
    }
    composing = false
    if (!nvimId || !event.data) return
    void window.workbench.nvim.input(nvimId, event.data.replaceAll('<', '<lt>'))
    if (inputEl) inputEl.textContent = ''
  }

  async function pushTheme(): Promise<void> {
    if (!nvimId) return
    const palette = store.activeTheme.palette
    try {
      await window.workbench.nvim.request(nvimId, 'nvim_exec_lua', [
        'grove_apply_theme(...)',
        [palette]
      ])
    } catch {
      // session already gone
    }
  }

  async function start(): Promise<void> {
    if (!hostEl || !canvasEl) return
    await document.fonts.ready
    font = { family: cssVar('--font-mono', 'monospace'), sizePx: fontSize() }
    metrics = measureCell(font)
    renderer = new CanvasGridRenderer()
    renderer.attach(canvasEl)
    renderer.setFont(font, metrics)

    const { cols, rows } = gridSize()
    renderer.resize(cols, rows, window.devicePixelRatio)
    lastWidth = hostEl.clientWidth
    lastHeight = hostEl.clientHeight

    try {
      nvimId = await window.workbench.nvim.create(
        store.selectedWorktreeId,
        cols,
        rows,
        store.activeTabPath ?? undefined
      )
    } catch {
      unavailable = true
      return
    }
    lastPushedPath = store.activeTabPath

    stopRedraw = window.workbench.on('event:nvim-redraw', (payload) => {
      const event = payload as { id: string; events: unknown[] }
      if (event.id === nvimId) handleRedraw(event.events)
    })
    stopExit = window.workbench.on('event:nvim-exit', (payload) => {
      const event = payload as { id: string }
      if (event.id !== nvimId) return
      nvimId = null
      layout.closeLeaf(leafId)
    })

    observer = new ResizeObserver(scheduleFit)
    observer.observe(hostEl)
    void pushTheme()
    inputEl?.focus()
  }

  function fontSize(): number {
    const configured = settings.get<number>('workbench.nvimFontSize')
    if (typeof configured === 'number' && configured > 4) return configured
    return 13
  }

  onMount(() => {
    keymap.setPaneMode(leafId, 'normal')
    void start()
  })

  // Spatial pane nav focuses the leaf container; pull focus into the input
  // element so keys reach nvim.
  $effect(() => {
    if (keymap.activePane === leafId) inputEl?.focus()
  })

  // Follow grove's active tab into nvim (finder/tree opens).
  $effect(() => {
    const path = store.activeTabPath
    if (!nvimId || !path || path === lastPushedPath) return
    lastPushedPath = path
    void window.workbench.nvim
      .request(nvimId, 'nvim_cmd', [{ cmd: 'edit', args: [path] }, {}])
      .catch(() => {})
  })

  // Restyle nvim when grove's theme changes.
  $effect(() => {
    void store.activeTheme
    void pushTheme()
  })

  onDestroy(() => {
    stopRedraw?.()
    stopExit?.()
    observer?.disconnect()
    if (nvimId) void window.workbench.nvim.kill(nvimId)
    renderer?.dispose()
  })
</script>

<div
  bind:this={hostEl}
  class="relative h-full w-full overflow-hidden bg-canvas"
  onmousedown={() => inputEl?.focus()}
  role="none"
>
  {#if unavailable}
    <div class="flex h-full items-center justify-center text-dim">
      Neovim runtime missing — run `bun scripts/fetch-nvim.ts` and reopen this pane.
    </div>
  {:else}
    <canvas bind:this={canvasEl} class="block"></canvas>
    <div
      bind:this={inputEl}
      contenteditable="true"
      class="absolute left-0 top-0 h-0 w-0 overflow-hidden opacity-0 outline-none"
      role="textbox"
      tabindex="0"
      aria-label="Neovim input"
      onkeydown={handleKeydown}
      oncompositionstart={handleComposition}
      oncompositionend={handleComposition}
      onfocus={() => keymap.setPaneMode(leafId, mapMode(grid.modeName))}
    ></div>
  {/if}
</div>
