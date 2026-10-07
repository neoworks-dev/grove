<script lang="ts">
  // A process's live output in an xterm, drawn like Grove's own terminals.
  // Typing goes to the process; the terminal's size becomes the process's.
  import { onMount } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { cssVar, terminalTheme } from '@grove/plugin-sdk/terminal'
  import { projectState } from './project.svelte'

  let { name }: { name: string } = $props()

  let hostEl: HTMLDivElement
  let terminal: Terminal | null = null

  onMount(() => {
    const term = new Terminal({
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: 12,
      scrollback: 5000,
      cursorBlink: false,
      theme: terminalTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostEl)
    terminal = term

    const stopWatching = projectState.watchOutput(name, (event) => {
      if (event.reset) term.reset()
      if (event.data) term.write(event.data)
    })
    term.onData((data) => projectState.send({ type: 'input', name, data }))
    const stopFitting = fitToHost(term, fit)

    return () => {
      stopWatching()
      stopFitting()
      term.dispose()
      terminal = null
    }
  })

  // Follow Grove's theme while the terminal is open.
  $effect(() => {
    void projectState.themeVersion
    if (terminal) terminal.options.theme = terminalTheme()
  })

  /** Keeps the terminal, and the process's pty with it, the size of its box. */
  function fitToHost(term: Terminal, fit: FitAddon): () => void {
    let cols = 0
    let rows = 0
    const observer = new ResizeObserver(() => {
      if (hostEl.clientWidth === 0 || hostEl.clientHeight === 0) return
      fit.fit()
      if (term.cols === cols && term.rows === rows) return
      cols = term.cols
      rows = term.rows
      projectState.send({ type: 'resize', name, cols, rows })
    })
    observer.observe(hostEl)
    return () => observer.disconnect()
  }
</script>

<div bind:this={hostEl} class="h-full w-full"></div>
