<script lang="ts">
  // The editor buffer tab strip for the Neovim center pane, showing the row of
  // open files. Dirty state is optional; NvimPane sources it from nvim's
  // 'modified' flag and marks those tabs with a dot ahead of the file icon.
  // Files side by side in nvim's splits share one tab, `a | b | c`.
  import Icon from '@iconify/svelte'
  import ArrowsLeftRightIcon from 'phosphor-svelte/lib/ArrowsLeftRightIcon'
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon'
  import { nextHiddenTab, tabOverflow, type TabOverflow, type TabSpan } from '../lib/tabOverflow'
  import { stripEntries, type SplitSegment, type SplitWindow } from '../lib/nvim/splitTabs'
  import { store, type TabDiff } from '../lib/store.svelte'
  import { fileIcon } from '../lib/icons'
  import PaneControls from './PaneControls.svelte'

  interface Tab {
    path: string
    name: string
    pinned?: boolean
    worktreeId: string
    scratch?: boolean
    diff?: TabDiff
  }

  /** File-type icon for a tab, tracking the active icon pack. */
  function iconFor(tab: Tab): string {
    store.iconPack
    return fileIcon(tab.name)
  }

  let {
    tabs,
    splits = [],
    currentWin = 0,
    dirtyPaths = {},
    onSelect,
    onClose,
    onSelectSplit,
    onCloseSplit
  }: {
    tabs: Tab[]
    splits?: SplitWindow[]
    currentWin?: number
    dirtyPaths?: Record<string, boolean>
    onSelect: (path: string) => void
    onClose: (path: string, event: MouseEvent) => void
    onSelectSplit?: (win: number) => void
    onCloseSplit?: (win: number, event: MouseEvent) => void
  } = $props()

  const entries = $derived(stripEntries(tabs, splits))

  /** The segment the split tab stands for when scrolling: the focused window's, else the first. */
  function leadingSegment(segments: SplitSegment<Tab>[]): SplitSegment<Tab> {
    const focused = segments.find((segment) => segment.win === currentWin)
    if (focused !== undefined) return focused
    return segments[0]
  }

  let stripEl = $state<HTMLDivElement>()
  let rowEl = $state<HTMLDivElement>()
  // Tabs scrolled out of view on either side, shown at that edge so a long
  // row says how much more there is and which way.
  let overflow = $state<TabOverflow>({ left: 0, right: 0 })

  /** Each tab's extent within the scrolled row, in order. */
  function measureSpans(strip: HTMLElement): TabSpan[] {
    const stripLeft = strip.getBoundingClientRect().left
    const spans: TabSpan[] = []
    for (const el of strip.querySelectorAll<HTMLElement>('[data-tab]')) {
      const bounds = el.getBoundingClientRect()
      const start = bounds.left - stripLeft + strip.scrollLeft
      spans.push({ start, end: start + bounds.width })
    }
    return spans
  }

  /** Recounts the tabs out of view. */
  function measureOverflow(): void {
    if (!stripEl) return
    const viewStart = stripEl.scrollLeft
    overflow = tabOverflow(measureSpans(stripEl), viewStart, viewStart + stripEl.clientWidth)
  }

  /** The edge counter's tooltip, e.g. "3 more tabs to the right". */
  function moreTabsLabel(count: number, side: 'left' | 'right'): string {
    if (count === 1) return `1 more tab to the ${side}`
    return `${count} more tabs to the ${side}`
  }

  /** Scrolls the nearest tab cut off on `side` into view. */
  function revealHidden(side: 'left' | 'right'): void {
    if (!stripEl) return
    const viewStart = stripEl.scrollLeft
    const spans = measureSpans(stripEl)
    const index = nextHiddenTab(spans, viewStart, viewStart + stripEl.clientWidth, side)
    if (index < 0) return
    const tabEls = stripEl.querySelectorAll<HTMLElement>('[data-tab]')
    tabEls[index]?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }

  // Recount as the strip scrolls, as the pane resizes, and as tabs come and go
  // or change width (a diff label, a pin).
  $effect(() => {
    if (!stripEl || !rowEl) return
    const strip = stripEl
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(strip)
    observer.observe(rowEl)
    strip.addEventListener('scroll', measureOverflow, { passive: true })
    return () => {
      observer.disconnect()
      strip.removeEventListener('scroll', measureOverflow)
    }
  })

  // Keep the active tab visible when it changes (opened via finder/tree while
  // the strip is scrolled elsewhere).
  $effect(() => {
    const active = store.activeTabPath
    if (!stripEl || !active) return
    for (const el of stripEl.querySelectorAll<HTMLElement>('[data-tab]')) {
      if (el.dataset.tab !== active) continue
      el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
      return
    }
  })
</script>

<!-- A tab's face: pin, unsaved dot, file icon, name and, for a diff, its sides. -->
{#snippet tabLabel(tab: Tab)}
  {#if tab.pinned}<PushPinIcon weight="fill" size={11} class="shrink-0 text-amber" />{/if}
  <!-- Unsaved marker sits ahead of the file icon, so a scanning eye
     finds every dirty tab in one straight column. -->
  {#if dirtyPaths[tab.path]}<span
      class="shrink-0 text-[8px] leading-none text-amber"
      title="Unsaved changes">●</span
    >{/if}
  <Icon icon={iconFor(tab)} width="13" height="13" class="shrink-0" />
  <span>{tab.name}</span>
  {#if tab.diff}
    <span
      class="flex max-w-56 items-center gap-0.5 font-mono text-2xs opacity-70"
      title="{tab.diff.left} ⇄ {tab.diff.right}"
    >
      <span class="truncate">{tab.diff.left}</span>
      <ArrowsLeftRightIcon size={10} class="shrink-0" />
      <span class="truncate">{tab.diff.right}</span>
    </span>
  {/if}
{/snippet}

{#snippet plainTab(tab: Tab)}
  {@const active = store.activeTabPath === tab.path}
  {@const tinted = tab.scratch || tab.diff !== undefined}
  <!-- Floating pills: inactive tabs sit flat on the strip, the active one
     lifts to elevated. Ephemeral scratch buffers (batch rename, a
     commit's revision) and files open as one side of a diff get an
     amber tint so they read as distinct from plain file tabs; a diff
     also names the two sides it is between. -->
  <div
    data-tab={tab.path}
    class="group/tab flex h-6 shrink-0 cursor-pointer items-center rounded-md px-2 text-xs {!active &&
    tinted
      ? 'bg-amber-soft/40'
      : ''}"
    class:bg-elevated={active && !tinted}
    class:text-default={active && !tinted}
    class:text-dim={!active && !tinted}
    class:hover:bg-hover={!active && !tinted}
    class:hover:text-default={!active && !tinted}
    class:text-amber={tinted}
    class:bg-amber-soft={active && tinted}
    class:hover:bg-amber-soft={!active && tinted}
  >
    <button class="flex cursor-pointer items-center gap-1.5" onclick={() => onSelect(tab.path)}>
      {@render tabLabel(tab)}
    </button>
    <button
      class="inline-flex w-0 shrink-0 cursor-pointer items-center overflow-hidden text-dim opacity-0 transition-all duration-150 ease-out hover:text-red group-hover/tab:ml-1 group-hover/tab:w-3.5 group-hover/tab:opacity-100"
      title="Close tab"
      onclick={(event) => onClose(tab.path, event)}>✕</button
    >
  </div>
{/snippet}

<!-- The files side by side in nvim's splits, as one pill in window order. The
   pill lifts like an active tab while the focused file is one of them; inside
   it the focused window's segment is bright and the rest dim. A segment's ✕
   closes that split, not the file. -->
{#snippet splitTab(segments: SplitSegment<Tab>[])}
  {@const active = segments.some((segment) => segment.tab.path === store.activeTabPath)}
  <div
    data-tab={leadingSegment(segments).tab.path}
    class="flex h-6 shrink-0 items-center rounded-md px-1 text-xs"
    class:bg-elevated={active}
    class:hover:bg-hover={!active}
  >
    {#each segments as segment, index (segment.win)}
      {@const focused = segment.win === currentWin}
      {#if index > 0}<span class="px-0.5 text-dim" aria-hidden="true">|</span>{/if}
      <div
        class="group/split flex items-center rounded px-1"
        class:text-default={focused}
        class:text-dim={!focused}
        class:hover:text-default={!focused}
      >
        <button
          class="flex cursor-pointer items-center gap-1.5"
          title="Focus this split"
          onclick={() => onSelectSplit?.(segment.win)}
        >
          {@render tabLabel(segment.tab)}
        </button>
        <button
          class="inline-flex w-0 shrink-0 cursor-pointer items-center overflow-hidden text-dim opacity-0 transition-all duration-150 ease-out hover:text-red group-hover/split:ml-1 group-hover/split:w-3.5 group-hover/split:opacity-100"
          title="Close split"
          onclick={(event) => onCloseSplit?.(segment.win, event)}>✕</button
        >
      </div>
    {/each}
  </div>
{/snippet}

<div class="flex h-8 shrink-0 items-center bg-surface px-1.5">
  <div class="relative min-w-0 flex-1">
    <div bind:this={stripEl} class="no-scrollbar overflow-x-auto">
      <div bind:this={rowEl} class="flex w-max items-center gap-1">
        {#each entries as entry (entry.key)}
          {#if entry.kind === 'tab'}
            {@render plainTab(entry.tab)}
          {:else}
            {@render splitTab(entry.segments)}
          {/if}
        {/each}
      </div>
    </div>
    <!-- Fade over the cut-off edge, with how many tabs are past it; a click
       brings the nearest one in. -->
    {#if overflow.left > 0}
      <button
        class="absolute inset-y-0 left-0 z-10 flex cursor-pointer items-center gap-0.5 bg-linear-to-r from-surface from-60% to-transparent pl-0.5 pr-5 text-2xs tabular-nums text-dim hover:text-default"
        title={moreTabsLabel(overflow.left, 'left')}
        aria-label={moreTabsLabel(overflow.left, 'left')}
        onclick={() => revealHidden('left')}
      >
        <CaretLeftIcon size={10} />{overflow.left}
      </button>
    {/if}
    {#if overflow.right > 0}
      <button
        class="absolute inset-y-0 right-0 z-10 flex cursor-pointer items-center gap-0.5 bg-linear-to-l from-surface from-60% to-transparent pl-5 pr-0.5 text-2xs tabular-nums text-dim hover:text-default"
        title={moreTabsLabel(overflow.right, 'right')}
        aria-label={moreTabsLabel(overflow.right, 'right')}
        onclick={() => revealHidden('right')}
      >
        {overflow.right}<CaretRightIcon size={10} />
      </button>
    {/if}
  </div>
  <PaneControls class="ml-1.5" />
</div>
