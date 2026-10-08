<script lang="ts">
  // A process's live output in an xterm, drawn like Grove's own terminals.
  // Typing goes to the process; the terminal's size becomes the process's.
  //
  // Unwrapped (the default), the terminal is made wide enough for long lines
  // and scrolls sideways, and the process is told that width so it doesn't
  // break lines itself. Scrolled up, output keeps arriving below without
  // moving the view, and a button offers the way back down.
  import { onMount } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { SearchAddon } from '@xterm/addon-search'
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon'
  import { cssVar, terminalTheme } from '@grove/plugin-sdk/terminal'
  import OutputSearch from './OutputSearch.svelte'
  import { projectState } from './project.svelte'

  // Columns an unwrapped terminal gets at least: wide enough for log lines.
  const UNWRAPPED_COLS = 400

  let { name }: { name: string } = $props()

  let viewportEl: HTMLDivElement
  let hostEl: HTMLDivElement
  let terminal = $state<Terminal | null>(null)
  let searchAddon = $state<SearchAddon | null>(null)
  // Whether the view is at the end of the output, so new lines show as they come.
  let following = $state(true)
  let refit: (() => void) | null = null

  const wrap = $derived(projectState.prefs.wrap)

  onMount(() => {
    const term = new Terminal({
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: 12,
      scrollback: 5000,
      cursorBlink: false,
      // The search addon's match highlights are decorations, a proposed API.
      allowProposedApi: true,
      theme: terminalTheme()
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(hostEl)
    terminal = term
    searchAddon = search

    const stopWatching = projectState.watchOutput(name, (event) => {
      if (event.reset) term.reset()
      if (event.data) term.write(event.data)
    })
    term.onData((data) => projectState.send({ type: 'input', name, data }))
    const scrolled = term.onScroll(() => updateFollowing(term))
    const written = term.onWriteParsed(() => updateFollowing(term))
    const stopFitting = fitToViewport(term, fit)

    return () => {
      stopWatching()
      stopFitting()
      scrolled.dispose()
      written.dispose()
      term.dispose()
      terminal = null
      searchAddon = null
    }
  })

  // Follow Grove's theme while the terminal is open.
  $effect(() => {
    void projectState.themeVersion
    if (terminal) terminal.options.theme = terminalTheme()
  })

  // Re-lay out when wrapping is switched.
  $effect(() => {
    void wrap
    refit?.()
  })

  /** Notes whether the view sits at the end of the output. */
  function updateFollowing(term: Terminal): void {
    const buffer = term.buffer.active
    following = buffer.viewportY >= buffer.baseY
  }

  /** Back to the end of the output, following it again. */
  function jumpToLatest(): void {
    terminal?.scrollToBottom()
    following = true
  }

  /**
   * Keeps the terminal, and the process's pty with it, the size of the visible
   * area — or wider, unwrapped, with the visible area scrolling sideways.
   */
  function fitToViewport(term: Terminal, fit: FitAddon): () => void {
    let cols = 0
    let rows = 0
    refit = () => {
      if (viewportEl.clientWidth === 0 || viewportEl.clientHeight === 0) return
      const proposed = fit.proposeDimensions()
      if (!proposed || !proposed.cols || !proposed.rows) return
      let nextCols = proposed.cols
      if (!wrap) nextCols = Math.max(proposed.cols, UNWRAPPED_COLS)
      if (nextCols === cols && proposed.rows === rows) return
      cols = nextCols
      rows = proposed.rows
      term.resize(cols, rows)
      projectState.send({ type: 'resize', name, cols, rows })
    }
    const observer = new ResizeObserver(() => refit?.())
    observer.observe(viewportEl)
    return () => {
      observer.disconnect()
      refit = null
    }
  }
</script>

<div class="relative h-full w-full">
  <!-- The host keeps the visible area's size, so the fit addon measures that;
       an unwrapped terminal overflows it and the viewport scrolls sideways. -->
  <div bind:this={viewportEl} class="h-full w-full overflow-y-hidden" class:overflow-x-auto={!wrap}>
    <div bind:this={hostEl} class="h-full w-full"></div>
  </div>
  {#if projectState.searchOpen && searchAddon && terminal}
    <OutputSearch addon={searchAddon} {terminal} />
  {/if}
  {#if !following}
    <button
      class="absolute right-4 bottom-3 z-10 flex cursor-pointer items-center gap-1 rounded-full border border-line bg-elevated px-2.5 py-1 text-2xs text-default shadow-overlay hover:bg-raised"
      onclick={jumpToLatest}
    >
      <ArrowDownIcon size={12} />
      Jump to latest
    </button>
  {/if}
</div>
