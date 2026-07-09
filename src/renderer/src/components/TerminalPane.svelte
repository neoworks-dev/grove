<script lang="ts">
  // Integrated terminal: an xterm view bound to a node-pty session in main. The
  // pty runs the user's shell in the selected worktree with its WT_*/PORT vars.
  import { onMount, onDestroy } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'
  import { store } from '../lib/store.svelte'

  let hostEl = $state<HTMLDivElement>()
  let term: Terminal | null = null
  let fit: FitAddon | null = null
  let ptyId: string | null = null
  let stopData: (() => void) | null = null
  let stopExit: (() => void) | null = null
  let observer: ResizeObserver | null = null

  function cssVar(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  }

  // Derive the xterm palette from the app's theme tokens so it tracks the theme.
  function themeColors(): Record<string, string> {
    const fg = cssVar('--text', '#fafafa')
    const dim = cssVar('--text-dim', '#71717a')
    return {
      background: cssVar('--bg', '#0b0b0d'),
      foreground: fg,
      cursor: fg,
      cursorAccent: cssVar('--bg', '#0b0b0d'),
      selectionBackground: cssVar('--surface-hover', '#26262a'),
      black: cssVar('--bg-elevated', '#18181b'),
      red: cssVar('--ctx-red', '#f87171'),
      green: cssVar('--ctx-green', '#a3e635'),
      yellow: cssVar('--ctx-amber', '#fbbf24'),
      blue: cssVar('--ctx-blue', '#60a5fa'),
      magenta: cssVar('--ctx-violet', '#a78bfa'),
      cyan: '#22d3ee',
      white: cssVar('--text-muted', '#a1a1aa'),
      brightBlack: dim,
      brightRed: cssVar('--ctx-red', '#f87171'),
      brightGreen: cssVar('--ctx-green', '#a3e635'),
      brightYellow: cssVar('--ctx-amber', '#fbbf24'),
      brightBlue: cssVar('--ctx-blue', '#60a5fa'),
      brightMagenta: cssVar('--ctx-violet', '#a78bfa'),
      brightCyan: '#67e8f9',
      brightWhite: fg
    }
  }

  onMount(() => {
    if (!hostEl) return
    term = new Terminal({
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: 13,
      cursorBlink: true,
      theme: themeColors(),
      allowProposedApi: true
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostEl)

    // Start the pty once the view has a size, then wire the streams.
    requestAnimationFrame(() => void start())

    observer = new ResizeObserver(() => {
      try {
        fit?.fit()
      } catch {
        // not laid out yet
      }
    })
    observer.observe(hostEl)
  })

  async function start(): Promise<void> {
    if (!term || !fit) return
    try {
      fit.fit()
    } catch {
      // ignore
    }
    ptyId = await window.workbench.terminal.create(store.selectedWorktreeId, term.cols, term.rows)

    term.onData((data) => {
      if (ptyId) void window.workbench.terminal.write(ptyId, data)
    })
    term.onResize(({ cols, rows }) => {
      if (ptyId) void window.workbench.terminal.resize(ptyId, cols, rows)
    })
    stopData = window.workbench.on('event:terminal-data', (payload) => {
      const event = payload as { id: string; data: string }
      if (event.id === ptyId) term?.write(event.data)
    })
    stopExit = window.workbench.on('event:terminal-exit', (payload) => {
      const event = payload as { id: string }
      if (event.id !== ptyId) return
      term?.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
      ptyId = null
    })
    term.focus()
  }

  onDestroy(() => {
    stopData?.()
    stopExit?.()
    observer?.disconnect()
    if (ptyId) void window.workbench.terminal.kill(ptyId)
    term?.dispose()
  })
</script>

<div bind:this={hostEl} class="h-full w-full overflow-hidden bg-canvas px-2 py-1"></div>
