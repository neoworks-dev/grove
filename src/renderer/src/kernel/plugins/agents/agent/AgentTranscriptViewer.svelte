<script lang="ts">
  // The detailed transcript, in place of the conversation: every message with its
  // time, tool calls opened up, read like a pager. Plain on purpose; the agent pane's
  // overlays get a design pass of their own.
  //
  // The keys are claimed through the key dispatcher while the viewer holds focus,
  // since the pane's bare-key bindings (j and k scroll, i focuses the composer) would
  // otherwise take them first.

  import { onDestroy, onMount, tick } from 'svelte'
  import { keyDispatch, KeyPriority } from '../../../../lib/keyDispatch'
  import {
    highlightSegments,
    matchingLines,
    promptLineFrom,
    stepMatch,
    viewerLinesOf,
    type ViewerLine,
    type ViewerSource
  } from '../../../../lib/agents/transcriptViewer'

  let {
    source,
    toggleKeys,
    onClose
  }: {
    source: ViewerSource
    /** The keys that toggle the viewer, as keycap labels, for the hint line. */
    toggleKeys: string[]
    onClose: () => void
  } = $props()

  const lines = $derived(viewerLinesOf(source))

  let rootEl = $state<HTMLDivElement>()
  let scrollEl = $state<HTMLDivElement>()
  let searchInputEl = $state<HTMLInputElement>()
  let searching = $state(false)
  let query = $state('')
  // The scroll position and line to go back to when a search is cancelled.
  let positionBeforeSearch = { scrollTop: 0, line: 0 }
  // The line of the match being looked at, or null before one is chosen.
  let currentMatch = $state<number | null>(null)

  const matches = $derived(matchingLines(lines, query))

  // Opens at the newest message, where the conversation left off.
  onMount(() => {
    rootEl?.focus()
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
  })

  /** Moves the keyboard into the viewer, for the pane to call when it takes focus. */
  export function focus(): boolean {
    if (!rootEl) return false
    if (searching && searchInputEl) {
      searchInputEl.focus()
      return true
    }
    rootEl.focus()
    return true
  }

  /** The height of one line of text, for stepping a line at a time. */
  function lineHeight(): number {
    const first = scrollEl?.querySelector<HTMLElement>('[data-line]')
    if (!first) return 16
    return first.offsetHeight
  }

  /** The index of the first line at least partly in view. */
  function topLine(): number {
    if (!scrollEl) return 0
    const rows = scrollEl.querySelectorAll<HTMLElement>('[data-line]')
    for (let index = 0; index < rows.length; index++) {
      if (rows[index].offsetTop + rows[index].offsetHeight > scrollEl.scrollTop) return index
    }
    return Math.max(0, rows.length - 1)
  }

  /** Scrolls so that a line sits at the top. */
  function showLineAtTop(index: number): void {
    const row = scrollEl?.querySelector<HTMLElement>(`[data-line="${index}"]`)
    if (!row || !scrollEl) return
    scrollEl.scrollTop = row.offsetTop
  }

  /** Scrolls so that a line sits in the middle of the view, for a search match. */
  function showLineCentered(index: number): void {
    const row = scrollEl?.querySelector<HTMLElement>(`[data-line="${index}"]`)
    if (!row || !scrollEl) return
    scrollEl.scrollTop = row.offsetTop - scrollEl.clientHeight / 2
  }

  /** Scrolls by a number of pixels. */
  function scrollBy(pixels: number): void {
    scrollEl?.scrollBy({ top: pixels })
  }

  /** Scrolls by a fraction of the viewport height. */
  function scrollByPage(fraction: number): void {
    if (!scrollEl) return
    scrollBy(scrollEl.clientHeight * fraction)
  }

  /** Jumps to the next or previous prompt, from whatever line is at the top. */
  function jumpPrompt(direction: 1 | -1): void {
    const target = promptLineFrom(lines, topLine(), direction)
    if (target === null) return
    showLineAtTop(target)
  }

  /** Goes to the next or previous search match, wrapping at the ends. */
  function jumpMatch(direction: 1 | -1): void {
    let from = topLine()
    if (currentMatch !== null) from = currentMatch
    const target = stepMatch(matches, from, direction)
    if (target === null) return
    currentMatch = target
    showLineCentered(target)
  }

  /** Opens the search box, remembering where to come back to. */
  async function startSearch(): Promise<void> {
    let scrollTop = 0
    if (scrollEl) scrollTop = scrollEl.scrollTop
    positionBeforeSearch = { scrollTop, line: topLine() }
    searching = true
    query = ''
    currentMatch = null
    await tick()
    searchInputEl?.focus()
  }

  /** Follows the typed query: the first match from where the search began is shown. */
  function onQueryInput(): void {
    const target = stepMatch(matches, positionBeforeSearch.line - 1, 1)
    currentMatch = target
    if (target === null) return
    showLineCentered(target)
  }

  /** Leaves the search box and keeps the matches for n and N. */
  function confirmSearch(): void {
    searching = false
    rootEl?.focus()
  }

  /** Drops the search and puts the scroll position back. */
  function cancelSearch(): void {
    searching = false
    query = ''
    currentMatch = null
    if (scrollEl) scrollEl.scrollTop = positionBeforeSearch.scrollTop
    rootEl?.focus()
  }

  /** Keys typed into the search box: Enter keeps the search, Escape drops it. */
  function onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      confirmSearch()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancelSearch()
    }
  }

  /** What each key does while the viewer is being read. */
  const KEY_ACTIONS: Record<string, () => void> = {
    q: () => onClose(),
    Escape: () => onClose(),
    j: () => scrollBy(lineHeight()),
    ArrowDown: () => scrollBy(lineHeight()),
    k: () => scrollBy(-lineHeight()),
    ArrowUp: () => scrollBy(-lineHeight()),
    g: () => scrollEl?.scrollTo({ top: 0 }),
    Home: () => scrollEl?.scrollTo({ top: 0 }),
    G: () => scrollEl?.scrollTo({ top: scrollEl.scrollHeight }),
    End: () => scrollEl?.scrollTo({ top: scrollEl.scrollHeight }),
    ' ': () => scrollByPage(0.9),
    b: () => scrollByPage(-0.9),
    PageDown: () => scrollByPage(0.9),
    PageUp: () => scrollByPage(-0.9),
    '{': () => jumpPrompt(-1),
    '}': () => jumpPrompt(1),
    '/': () => void startSearch(),
    n: () => jumpMatch(1),
    N: () => jumpMatch(-1)
  }

  /** The viewer's Ctrl chords: half and full pages, and Ctrl+C to leave. */
  const CTRL_ACTIONS: Record<string, () => void> = {
    u: () => scrollByPage(-0.5),
    d: () => scrollByPage(0.5),
    b: () => scrollByPage(-0.9),
    f: () => scrollByPage(0.9),
    c: () => onClose()
  }

  /** The action for a key press, or undefined when the viewer has none for it. */
  function actionFor(event: KeyboardEvent): (() => void) | undefined {
    if (event.altKey || event.metaKey) return undefined
    if (event.ctrlKey) return CTRL_ACTIONS[event.key]
    return KEY_ACTIONS[event.key]
  }

  /** Whether a key is a plain typed character, which nothing behind the viewer should see. */
  function isBareKey(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.altKey || event.metaKey) return false
    return event.key.length === 1
  }

  /**
   * Claims the viewer's keys while it has focus. Plain characters it has no use for
   * are swallowed as well, so the pane's own one-key bindings stay out of the way.
   */
  function onKey(event: KeyboardEvent): boolean {
    const target = event.target
    if (!(target instanceof Node) || !rootEl?.contains(target)) return false
    if (target === searchInputEl) return false
    const action = actionFor(event)
    if (!action && !isBareKey(event)) return false
    event.preventDefault()
    event.stopPropagation()
    if (action) action()
    return true
  }

  const unsubscribe = keyDispatch.subscribe(KeyPriority.menu, onKey)
  onDestroy(unsubscribe)

  /** The class for a line, by what kind of line it is. */
  function lineClass(line: ViewerLine, index: number): string {
    let classes = 'whitespace-pre-wrap break-words px-3 '
    if (line.kind === 'header') classes += 'mt-1 font-medium text-default '
    if (line.kind === 'body') classes += 'text-muted '
    if (line.kind === 'detail') classes += 'pl-6 text-dim '
    if (index === currentMatch) classes += 'bg-hover '
    return classes
  }
</script>

<!-- Replaces the transcript: the composer stays under it. Q, Esc or the toggle key brings the conversation back. -->
<div
  bind:this={rootEl}
  class="flex min-h-0 flex-1 flex-col outline-none"
  role="application"
  aria-label="Transcript"
  tabindex="-1"
  data-testid="transcript-viewer"
>
  <div bind:this={scrollEl} class="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-2xs">
    {#each lines as line, index (index)}
      <div
        class={lineClass(line, index)}
        data-line={index}
        data-prompt={line.promptStart ? 'true' : undefined}
      >
        {#each highlightSegments(line.text, query) as segment, segmentIndex (segmentIndex)}
          {#if segment.match}<mark class="bg-amber-soft text-amber">{segment.text}</mark
            >{:else}{segment.text}{/if}
        {/each}
        {#if line.text === ''}&nbsp;{/if}
      </div>
    {/each}
  </div>

  <div class="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1 text-2xs text-dim">
    {#if searching}
      <span>/</span>
      <input
        bind:this={searchInputEl}
        bind:value={query}
        oninput={onQueryInput}
        onkeydown={onSearchKeydown}
        class="min-w-0 flex-1 bg-transparent text-default outline-none"
        aria-label="Search the transcript"
      />
      <span>{matches.length} found</span>
    {:else}
      <span class="min-w-0 flex-1 truncate">
        Detailed transcript · {toggleKeys.join(' ')} or q to leave · / to search
        {#if query !== ''}· {matches.length} found, n and N step{/if}
      </span>
    {/if}
  </div>
</div>
