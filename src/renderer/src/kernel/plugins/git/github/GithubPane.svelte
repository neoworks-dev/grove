<script lang="ts">
  // Launchpad: every pull request and issue for the open repository in one list,
  // grouped by what each needs, side by side with the selected item's thread.
  // The issues can also be laid out as a board or on a calendar. Loads on
  // mount, then polls in the background; the poll stops with the pane.
  import {
    github,
    refreshDashboard,
    selectItem,
    startAutoRefresh,
    loadRepoPins
  } from './store.svelte'
  import LaunchpadList from './LaunchpadList.svelte'
  import { launchpadGroups, type LaunchpadGroup } from './launchpad'
  import { store } from '../../../../lib/store.svelte'
  import GithubBoard from './GithubBoard.svelte'
  import GithubViewTabs from './GithubViewTabs.svelte'
  import GithubCalendar from './GithubCalendar.svelte'
  import { boardColumns } from './board'
  import type { IssueLayout } from './views'
  import GithubSplitHandle from './GithubSplitHandle.svelte'
  import GithubThread from './GithubThread.svelte'
  import GithubCompose from './GithubCompose.svelte'
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import GithubSelectionBar from './GithubSelectionBar.svelte'
  import GithubFilterBar from './GithubFilterBar.svelte'
  import GithubSearchBox from './GithubSearchBox.svelte'
  import { ageLabel } from './filter'
  import { DEFAULT_QUERY, setStateQualifier } from './search'
  import type {
    GithubIssueField,
    GithubIssueItem,
    GithubItemKind,
    GithubStateFilter
  } from '../../../../../../shared/types'
  import RowAction from '../../../../components/RowAction.svelte'

  // Below this the pane shows one column at a time: the list, or the thread with
  // a way back.
  const NARROW_PX = 720

  // The box takes GitHub's syntax, so it needs somewhere to say what that is.
  // A hover title rather than a panel: it is read once and then never again.
  const SEARCH_HELP = [
    'GitHub search qualifiers:',
    'is:open  is:closed  is:merged  is:draft  is:pr  is:issue',
    'author:  assignee:  (use @me for yourself)',
    'label:  milestone:  type:  project:  head:  base:',
    'no:label  no:assignee  no:milestone  no:type  no:project',
    'Put - in front to exclude, and "quotes" around names with spaces.'
  ].join('\n')

  /** The list's share of the pane beside the thread, for each way issues are shown. */
  interface SplitShares {
    list: number
    board: number
  }

  let width = $state(0)
  const narrow = $derived(width > 0 && width < NARROW_PX)
  const items = $derived(github.items)
  const pins = $derived(new Set(github.pins))
  // The layouts the issues can take here: a board needs a single-select field
  // to group by, a calendar a date field to place by.
  const layouts = $derived.by(() => {
    const available: { id: IssueLayout; label: string }[] = [{ id: 'list', label: 'List' }]
    if (github.issueFields.length > 0) available.push({ id: 'board', label: 'Board' })
    if (github.dateFields.length > 0) available.push({ id: 'calendar', label: 'Calendar' })
    return available
  })
  // Pull requests by what they need, then issues by who has them. A list
  // grouped by an issue field shows the issues in the board's columns instead,
  // including the empty ones, so the grouping reads the same in both layouts.
  const groups = $derived.by(() => {
    const listField = github.listField
    if (!listField) return launchpadGroups(items, github.viewer, pins)
    return launchpadGroups(items, github.viewer, pins, (issues) =>
      fieldGroups(issues, listField)
    )
  })

  /** The issues in a field's board columns, as Launchpad groups. */
  function fieldGroups(issues: GithubIssueItem[], field: GithubIssueField): LaunchpadGroup[] {
    return boardColumns(issues, field).map((column) => ({
      id: `field:${column.name}`,
      title: column.name,
      items: column.issues,
      colour: column.color
    }))
  }

  // Pins belong to the repository, so a different one opening reads its own.
  $effect(() => {
    void store.repo
    loadRepoPins()
  })
  // An empty list under the query it started with is "nothing here", not "your
  // search found nothing" — `is:open` is not something the user typed.
  const narrowed = $derived(github.query.trim() !== DEFAULT_QUERY && github.query.trim().length > 0)

  // Load on mount and whenever the state filter changes — it is a different
  // query, not a client-side cut of what is already here.
  $effect(() => {
    void refreshDashboard(github.stateFilter)
  })

  $effect(() => startAutoRefresh())

  // The dropdown is a shortcut for writing `is:` into the query, not a filter
  // beside it — there is one place a narrowing is written down.
  function setStateFilter(event: Event): void {
    const state = (event.currentTarget as HTMLSelectElement).value as GithubStateFilter
    github.query = setStateQualifier(github.query, state)
  }

  // The right-hand column carries either the composer or the selected thread;
  // on a narrow pane it takes the whole width, and the list steps aside.
  const detailColumnShown = $derived(github.composing || github.selection !== null)

  // The list keeps a share of a wide pane that the handle between it and the
  // thread sets, and the whole of a narrow one. The board keeps a share of its
  // own, since it wants more room, and takes the whole pane with no thread open.
  const SPLIT_KEY = 'grove.github.split'
  const DEFAULT_SHARES: SplitShares = { list: 0.4, board: 0.55 }
  let shares = $state<SplitShares>(loadShares())
  const splitKind = $derived<keyof SplitShares>(github.wideLayoutShown ? 'board' : 'list')

  const listWidth = $derived.by(() => {
    if (narrow) return '100%'
    if (github.wideLayoutShown && !detailColumnShown) return '100%'
    return `${shares[splitKind] * 100}%`
  })

  /** The stored split for the list and the board, falling back to the defaults. */
  function loadShares(): SplitShares {
    try {
      const raw = localStorage.getItem(SPLIT_KEY)
      if (raw === null) return { ...DEFAULT_SHARES }
      return { ...DEFAULT_SHARES, ...(JSON.parse(raw) as Partial<SplitShares>) }
    } catch {
      return { ...DEFAULT_SHARES }
    }
  }

  /** Moves the split for whatever is showing, keeping it when `persist` says so. */
  function setShare(share: number, persist: boolean): void {
    shares = { ...shares, [splitKind]: share }
    if (!persist) return
    try {
      localStorage.setItem(SPLIT_KEY, JSON.stringify(shares))
    } catch {
      // Unavailable storage only costs remembering it.
    }
  }

  // Beside the list the thread column is always there, empty until something
  // is picked; beside the board it only opens with an issue in it.
  const detailColumnVisible = $derived.by(() => {
    if (detailColumnShown) return true
    if (narrow) return false
    return !github.wideLayoutShown
  })

  function startCompose(): void {
    github.composing = true
  }

  // Opening a thread puts the composer away; the draft is kept in the store, so
  // coming back to it loses nothing.
  function openItem(kind: GithubItemKind, number: number): void {
    github.composing = false
    void selectItem({ kind, number })
  }

  // The repository and the age of the data have no room of their own now, so
  // they live on the control that acts on them.
  const refreshTitle = $derived.by<string>(() => {
    if (!github.dashboard) return 'Refresh'
    const age = ageLabel(new Date(github.dashboard.fetchedAt).toISOString())
    return `${github.dashboard.repo.nameWithOwner} — updated ${age}. Refresh`
  })

</script>

{#snippet detailColumn()}
  {#if github.composing}
    <GithubCompose />
  {:else}
    <GithubThread />
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col" bind:clientWidth={width}>
  {#if github.error}
    <p class="border-b border-line px-3 py-2 text-xs text-red">{github.error}</p>
  {/if}

  <div class="flex min-h-0 flex-1">
    {#if !narrow || !detailColumnShown}
      <div class="relative flex min-h-0 min-w-0 shrink-0 flex-col" style:width={listWidth}>
        {#if !narrow && detailColumnVisible}
          <GithubSplitHandle
            share={shares[splitKind]}
            paneWidth={width}
            onresize={(share) => setShare(share, false)}
            oncommit={(share) => setShare(share, true)}
            onreset={() => setShare(DEFAULT_SHARES[splitKind], true)}
          />
        {/if}
        {#if github.checked.length > 0}
          <GithubSelectionBar />
        {/if}
        <!-- The list's own header, not the pane's: a full-width strip left the
             thread beside it with a second header under an empty half. Each
             column carries its own, so they share one line. -->
        <div
          class="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5"
          class:hidden={github.checked.length > 0}
        >
          {#if layouts.length > 1}
            <div class="flex shrink-0 overflow-hidden rounded-md border border-line">
              {#each layouts as layout (layout.id)}
                <button
                  class="cursor-pointer px-1.5 py-0.5 text-2xs hover:bg-hover"
                  class:bg-hover={github.view === layout.id}
                  class:text-default={github.view === layout.id}
                  class:text-dim={github.view !== layout.id}
                  onclick={() => (github.view = layout.id)}
                >
                  {layout.label}
                </button>
              {/each}
            </div>
          {/if}

          <GithubSearchBox
            bind:value={github.query}
            placeholder="is:open label:bug"
            title={SEARCH_HELP}
          />

          <RowAction
            icon={ArrowClockwiseIcon}
            title={refreshTitle}
            disabled={github.loading}
            onclick={() => refreshDashboard(github.stateFilter)}
          />
          <RowAction icon={PlusIcon} title="New issue" onclick={startCompose} />
        </div>

        <GithubViewTabs />
        <GithubFilterBar {setStateFilter} />

        {#if github.boardShown && github.boardField}
          <GithubBoard field={github.boardField} onopen={(number) => openItem('issue', number)} />
        {:else if github.calendarShown && github.calendarRange}
          <GithubCalendar
            range={github.calendarRange}
            onopen={(number) => openItem('issue', number)}
          />
        {:else}
          {#if items.length > 0}
            <LaunchpadList {groups} onopen={(item) => openItem(item.kind, item.number)} />
          {:else}
            <p class="px-3 py-4 text-xs text-dim">
              {#if github.loading}
                Loading…
              {:else if narrowed}
                Nothing matches <span class="font-mono">{github.query}</span>.
              {:else}
                Nothing here.
              {/if}
            </p>
          {/if}
        {/if}
      </div>
    {/if}

    {#if detailColumnVisible}
      <div class="flex min-h-0 min-w-0 flex-1 flex-col border-line" class:border-l={!narrow}>
        <div class="min-h-0 flex-1">
          {@render detailColumn()}
        </div>
      </div>
    {/if}
  </div>
</div>
