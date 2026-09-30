<script lang="ts">
  // The one xterm setup every terminal in grove draws with: font, size, padding,
  // palette, the GPU renderer and fitting the grid to the pane. The shell
  // terminal and the agent terminal both mount this and only add what is their
  // own — a pty, a transcript — so the two cannot drift apart.
  import { onDestroy, onMount } from 'svelte'
  import { Terminal, type ITerminalOptions } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { WebglAddon } from '@xterm/addon-webgl'
  import '@xterm/xterm/css/xterm.css'
  import { layout } from '../lib/layout.svelte'
  import { store } from '../lib/store.svelte'
  import { cssVar, terminalTheme } from '../lib/terminalTheme'

  let {
    leafId,
    options = {},
    onReady
  }: {
    /** The pane the terminal is in, whose zoom scales its font. */
    leafId: string
    /** What this terminal does differently from the shared setup. */
    options?: ITerminalOptions
    /** Called once the terminal is open in the page, before it is first fitted. */
    onReady: (terminal: Terminal) => void
  } = $props()

  // xterm renders to its own canvas, so it scales its font from the pane's zoom
  // rather than the container CSS zoom used by DOM panes.
  const BASE_FONT_SIZE = 13

  let hostEl = $state<HTMLDivElement>()
  let term = $state.raw<Terminal | null>(null)
  let fit: FitAddon | null = null
  let webgl: WebglAddon | null = null
  let observer: ResizeObserver | null = null

  // Fit only when the host's pixel size actually changes, coalesced to one
  // animation frame. Fitting on every ResizeObserver tick lets xterm's own
  // relayout feed back into the observer and spin the main thread (a known
  // xterm + FitAddon hang).
  let fitScheduled = false
  let lastWidth = 0
  let lastHeight = 0

  /** Fits the grid to the host on the next frame, if its size changed since the last fit. */
  function scheduleFit(): void {
    if (fitScheduled) return
    fitScheduled = true
    requestAnimationFrame(() => {
      fitScheduled = false
      fitNow()
    })
  }

  /** Fits the grid to the host now, unless it is unchanged or not laid out. */
  function fitNow(): void {
    if (!hostEl || !fit) return
    const width = hostEl.clientWidth
    const height = hostEl.clientHeight
    if (width < 2 || height < 2) return
    if (width === lastWidth && height === lastHeight) return
    lastWidth = width
    lastHeight = height
    try {
      fit.fit()
    } catch {
      // not laid out yet
    }
  }

  /** Fits the grid on the next frame even when the host looks the same size, e.g. after being hidden. */
  export function refit(): void {
    lastWidth = 0
    lastHeight = 0
    scheduleFit()
  }

  /** Fits the grid now, for a caller that needs the final size before it goes on. */
  export function fitImmediately(): void {
    lastWidth = 0
    lastHeight = 0
    fitNow()
  }

  /**
   * Draw the grid on the GPU instead of rebuilding a DOM row per line.
   *
   * xterm's default DOM renderer repaints every visible row as elements, which a
   * full-screen TUI redrawing at 60Hz turns into thousands of node mutations a
   * second. The WebGL renderer uploads a glyph atlas once and blits from it.
   *
   * The context can be lost (driver reset, GPU process restart); disposing the
   * addon is what puts the DOM renderer back, so the terminal keeps working
   * rather than going blank.
   */
  function enableGpuRenderer(terminal: Terminal): void {
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        if (webgl === addon) webgl = null
      })
      terminal.loadAddon(addon)
      webgl = addon
    } catch (cause) {
      console.warn('[terminal] WebGL renderer unavailable, falling back to DOM:', cause)
    }
  }

  onMount(() => {
    if (!hostEl) return
    const terminal = new Terminal({
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: BASE_FONT_SIZE * layout.fontScale(leafId),
      theme: terminalTheme(),
      allowProposedApi: true,
      ...options
    })
    fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(hostEl)
    // Must follow open(): the addon needs the terminal's element to exist.
    enableGpuRenderer(terminal)
    term = terminal
    onReady(terminal)
    observer = new ResizeObserver(scheduleFit)
    observer.observe(hostEl)
    scheduleFit()
  })

  // Per-pane font zoom: resize xterm's font and refit the grid to the new cell.
  $effect(() => {
    const next = BASE_FONT_SIZE * layout.fontScale(leafId)
    if (!term || term.options.fontSize === next) return
    term.options.fontSize = next
    refit()
  })

  // Follow the app's theme. The palette is read from the theme's tokens, so a
  // terminal opened before a switch would otherwise keep the old background.
  $effect(() => {
    void store.activeTheme
    if (term) term.options.theme = terminalTheme()
  })

  onDestroy(() => {
    observer?.disconnect()
    webgl?.dispose()
    term?.dispose()
    term = null
  })
</script>

<div bind:this={hostEl} class="h-full w-full overflow-hidden bg-surface px-2 py-1"></div>
