<script lang="ts">
  // Embedded Neovim editor: a canvas-rendered ext_linegrid UI bound to a
  // vendored `nvim --embed` sidecar in main. Keys are encoded to vim
  // notation and forwarded; nvim reports modes back which feed the keymap
  // gate exactly like the CodeMirror editor pane.
  import { onMount, onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { keymap } from '../lib/keymap.svelte'
  import BufferTabs from './BufferTabs.svelte'
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
  let destroyed = false
  let leafEl: HTMLElement | null = null
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
  // Row the cursor was last painted on, so a plain cursor move repaints the
  // vacated row and never leaves a ghost block behind.
  let lastCursorRow = 0

  const activeTabs = $derived(
    store.tabs.filter((tab) => tab.worktreeId === store.selectedWorktreeId)
  )

  function selectTab(path: string): void {
    store.activeTabPath = path
  }

  function closeTab(path: string, event: MouseEvent): void {
    event.stopPropagation()
    store.closeTab(path)
  }

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
    // Cursor moves without row edits still need a repaint: the vacated row
    // (to erase the old block) and the new row.
    pendingDirtyRows.add(lastCursorRow)
    pendingDirtyRows.add(grid.cursor.row)
    lastCursorRow = grid.cursor.row
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
      // Changing canvas.width/height clears it; repaint the current grid at
      // once so the pane never shows a half-blank buffer while waiting for
      // nvim's grid_resize redraw.
      renderer.resize(cols, rows, window.devicePixelRatio)
      pendingDirtyAll = true
      scheduleRender()
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

    let spawnedId: string
    try {
      spawnedId = await window.workbench.nvim.spawn(store.selectedWorktreeId)
    } catch {
      unavailable = true
      return
    }
    // The pane may have been closed while spawn was in flight.
    if (destroyed) {
      void window.workbench.nvim.kill(spawnedId)
      return
    }
    nvimId = spawnedId
    lastPushedPath = store.activeTabPath

    // Subscribe before attaching: nvim emits its first redraw batch on
    // ui_attach, and Electron drops events that have no listener, so the
    // subscription must exist first or the canvas stays blank until a resize.
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
    await window.workbench.nvim.attach(nvimId, cols, rows, store.activeTabPath ?? undefined)
    void pushTheme()
    inputEl?.focus()
  }

  function fontSize(): number {
    const configured = settings.get<number>('workbench.nvimFontSize')
    if (typeof configured === 'number' && configured > 4) return configured
    return 13
  }

  // Pane navigation focuses the leaf container (spatial nav, focusLeafSoon);
  // steer that focus into the hidden input so keydown reaches nvim.
  function redirectLeafFocus(event: FocusEvent): void {
    if (event.target === leafEl) inputEl?.focus()
  }

  onMount(() => {
    keymap.setPaneMode(leafId, 'normal')
    leafEl = (hostEl?.closest('[data-leaf]') as HTMLElement | null) ?? null
    leafEl?.addEventListener('focusin', redirectLeafFocus)
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
    destroyed = true
    leafEl?.removeEventListener('focusin', redirectLeafFocus)
    stopRedraw?.()
    stopExit?.()
    observer?.disconnect()
    if (nvimId) void window.workbench.nvim.kill(nvimId)
    renderer?.dispose()
  })
</script>

<div class="flex h-full min-h-0 w-full flex-col">
  <BufferTabs tabs={activeTabs} onSelect={selectTab} onClose={closeTab} />

  <div
    bind:this={hostEl}
    class="relative min-h-0 flex-1 overflow-hidden bg-canvas"
    onmousedown={(event) => {
      // Without preventDefault the browser moves focus to the focusable leaf
      // container after this handler, stealing keys from the hidden input.
      event.preventDefault()
      inputEl?.focus()
    }}
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
</div>
