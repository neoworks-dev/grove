<script lang="ts">
  // Find in a process's output: a box over the top right of the terminal, like
  // an editor's find widget. Enter / Shift+Enter step through matches, Alt+R
  // and Alt+C toggle regex and case, Escape closes. Every match is highlighted.
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon'
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import type { Terminal } from '@xterm/xterm'
  import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'
  import { cssVar } from '@grove/plugin-sdk/terminal'
  import IconAction from './IconAction.svelte'
  import { projectState } from './project.svelte'
  import { mixHexColors, toHexColor } from './color'

  let { addon, terminal }: { addon: SearchAddon; terminal: Terminal } = $props()

  // How strongly matches are tinted amber: ordinary ones faintly, the current
  // one strongly. Text stays the terminal's colour, so neither can be solid.
  const MATCH_TINT = 0.22
  const ACTIVE_MATCH_TINT = 0.6

  let inputEl = $state<HTMLInputElement>()
  let query = $state('')
  let regex = $state(false)
  let caseSensitive = $state(false)
  let resultIndex = $state(-1)
  let resultCount = $state(0)

  // A regex that doesn't compile finds nothing, and says so.
  const invalid = $derived(regex && query !== '' && !compiles(query))

  /** Whether `pattern` is a valid regular expression. */
  function compiles(pattern: string): boolean {
    try {
      new RegExp(pattern)
      return true
    } catch {
      return false
    }
  }

  /**
   * How matches are found and drawn, in the theme's colours: every match a
   * faint amber wash, the current one a strong wash with a solid outline. The
   * outline is drawn above the cell backgrounds, so it shows even where the
   * two highlights overlap.
   */
  function searchOptions(incremental: boolean): ISearchOptions {
    void projectState.themeVersion
    const amber = toHexColor(cssVar('--ctx-amber', '#fbbf24'), '#fbbf24')
    const surface = toHexColor(cssVar('--surface', '#1c1c1e'), '#1c1c1e')
    const wash = mixHexColors(amber, surface, MATCH_TINT)
    const activeWash = mixHexColors(amber, surface, ACTIVE_MATCH_TINT)
    return {
      regex,
      caseSensitive,
      incremental,
      decorations: {
        matchBackground: wash,
        matchOverviewRuler: wash,
        activeMatchBackground: activeWash,
        activeMatchBorder: amber,
        activeMatchColorOverviewRuler: amber
      }
    }
  }

  /**
   * Runs a search step. The addon also selects the match it lands on, and the
   * selection is painted over the highlights in the same colour as any other
   * selection, hiding which match is current; drop it.
   */
  function find(direction: 'next' | 'previous', incremental: boolean): void {
    if (direction === 'next') {
      addon.findNext(query, searchOptions(incremental))
    } else {
      addon.findPrevious(query, searchOptions(incremental))
    }
    terminal.clearSelection()
  }

  // Follow the addon's count of matches.
  $effect(() => {
    const subscription = addon.onDidChangeResults((results) => {
      resultIndex = results.resultIndex
      resultCount = results.resultCount
    })
    return () => subscription.dispose()
  })

  // Search again as the query or its options change.
  $effect(() => {
    void [query, regex, caseSensitive]
    if (query === '' || invalid) {
      addon.clearDecorations()
      resultIndex = -1
      resultCount = 0
      return
    }
    find('next', true)
  })

  // Take focus whenever a key asks for it.
  $effect(() => {
    void projectState.searchFocusRequests
    inputEl?.focus()
    inputEl?.select()
  })

  /** Moves to the next or previous match. */
  function step(direction: 'next' | 'previous'): void {
    if (query === '' || invalid) return
    find(direction, false)
  }

  /** Closes the search and takes its highlights with it. */
  function close(): void {
    addon.clearDecorations()
    projectState.searchOpen = false
  }

  /** The search box's own keys: stepping, the toggles, closing. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      step(event.shiftKey ? 'previous' : 'next')
    } else if (event.key === 'Escape') {
      close()
    } else if (event.altKey && event.code === 'KeyR') {
      regex = !regex
    } else if (event.altKey && event.code === 'KeyC') {
      caseSensitive = !caseSensitive
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  /** "3 of 17", "No results", or nothing before a query. */
  function countLabel(): string {
    if (invalid) return 'Invalid regex'
    if (query === '') return ''
    if (resultCount === 0) return 'No results'
    if (resultIndex < 0) return `${resultCount} found`
    return `${resultIndex + 1} of ${resultCount}`
  }
</script>

<div
  class="absolute top-1 right-3 z-10 flex items-center gap-1 rounded-md border border-line bg-elevated px-1.5 py-1 shadow-overlay"
>
  <input
    bind:this={inputEl}
    bind:value={query}
    class="w-48 bg-transparent px-1 font-mono text-2xs text-default outline-none placeholder:text-faint"
    class:text-red={invalid}
    placeholder="Find in output"
    spellcheck="false"
    onkeydown={onKeydown}
  />
  <button
    class="grid h-5 min-w-5 cursor-pointer place-items-center rounded px-0.5 font-mono text-2xs hover:bg-raised"
    class:text-default={caseSensitive}
    class:bg-raised={caseSensitive}
    class:text-dim={!caseSensitive}
    title="Match case (Alt+C)"
    aria-pressed={caseSensitive}
    onclick={() => (caseSensitive = !caseSensitive)}
  >
    Aa
  </button>
  <button
    class="grid h-5 min-w-5 cursor-pointer place-items-center rounded px-0.5 font-mono text-2xs hover:bg-raised"
    class:text-default={regex}
    class:bg-raised={regex}
    class:text-dim={!regex}
    title="Regular expression (Alt+R)"
    aria-pressed={regex}
    onclick={() => (regex = !regex)}
  >
    .*
  </button>
  <span class="min-w-16 px-1 text-right text-2xs text-dim" class:text-red={invalid}>{countLabel()}</span>
  <IconAction icon={ArrowUpIcon} title="Previous match (Shift+Enter)" onclick={() => step('previous')} />
  <IconAction icon={ArrowDownIcon} title="Next match (Enter)" onclick={() => step('next')} />
  <IconAction icon={XIcon} title="Close (Escape)" onclick={close} />
</div>
