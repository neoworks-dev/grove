<script lang="ts">
  // The GitHub pane: pull requests and issues for the open repository, side by
  // side with the selected item's thread. Loads on mount, then polls in the
  // background; the poll stops with the pane.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import {
    github,
    refreshDashboard,
    selectItem,
    startAutoRefresh,
    toggleChecked
  } from './store.svelte'
  import GithubItemRow from './GithubItemRow.svelte'
  import GithubThread from './GithubThread.svelte'
  import GithubCompose from './GithubCompose.svelte'
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import GithubSelectionBar from './GithubSelectionBar.svelte'
  import GithubFilterBar from './GithubFilterBar.svelte'
  import { ageLabel } from './filter'
  import { DEFAULT_QUERY, setStateQualifier } from './search'
  import type { GithubItemKind, GithubStateFilter } from '../../../../../shared/types'

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

  let width = $state(0)
  const narrow = $derived(width > 0 && width < NARROW_PX)
  const items = $derived(github.items)
  // An empty list under the query it started with is "nothing here", not "your
  // search found nothing" — `is:open` is not something the user typed.
  const narrowed = $derived(github.query.trim() !== DEFAULT_QUERY && github.query.trim().length > 0)
  const counts = $derived(github.counts)
  const viewer = $derived.by<string | null>(() => {
    if (!github.dashboard) return null
    return github.dashboard.viewer
  })

  // Load on mount and whenever the state filter changes — it is a different
  // query, not a client-side cut of what is already here.
  $effect(() => {
    void refreshDashboard(github.stateFilter)
  })

  $effect(() => startAutoRefresh())

  // The list keeps a fixed share of a wide pane, and the whole of a narrow one.
  const listWidth = $derived.by(() => {
    if (narrow) return '100%'
    return '40%'
  })

  function switchTab(kind: GithubItemKind): void {
    github.tab = kind
    // Numbers are per kind, so a selection does not survive the switch.
    github.checked = []
    void selectItem(null)
  }

  // The dropdown is a shortcut for writing `is:` into the query, not a filter
  // beside it — there is one place a narrowing is written down.
  function setStateFilter(event: Event): void {
    const state = (event.currentTarget as HTMLSelectElement).value as GithubStateFilter
    github.query = setStateQualifier(github.query, state)
  }

  // The right-hand column carries either the composer or the selected thread;
  // on a narrow pane it takes the whole width, and the list steps aside.
  const detailColumnShown = $derived(github.composing || github.selection !== null)

  function startCompose(): void {
    github.composing = true
  }

  // Opening a thread puts the composer away; the draft is kept in the store, so
  // coming back to it loses nothing.
  function openItem(kind: GithubItemKind, number: number): void {
    github.composing = false
    void selectItem({ kind, number })
  }

  function backToList(): void {
    if (github.composing) {
      github.composing = false
      return
    }
    void selectItem(null)
  }

  // The repository and the age of the data have no room of their own now, so
  // they live on the control that acts on them.
  const refreshTitle = $derived.by<string>(() => {
    if (!github.dashboard) return 'Refresh'
    const age = ageLabel(new Date(github.dashboard.fetchedAt).toISOString())
    return `${github.dashboard.repo.nameWithOwner} — updated ${age}. Refresh`
  })

  function isSelected(number: number, kind: GithubItemKind): boolean {
    const selection = github.selection
    if (!selection) return false
    return selection.number === number && selection.kind === kind
  }
</script>

<div class="flex h-full min-h-0 flex-col" bind:clientWidth={width}>
  {#if github.error}
    <p class="border-b border-line px-3 py-2 text-xs text-red">{github.error}</p>
  {/if}

  <div class="flex min-h-0 flex-1">
    {#if !narrow || !detailColumnShown}
      <div class="flex min-h-0 min-w-0 shrink-0 flex-col" style:width={listWidth}>
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
          <button
            class="shrink-0 rounded-md px-1.5 py-0.5 text-xs hover:bg-hover"
            class:text-default={github.tab === 'pull'}
            class:text-dim={github.tab !== 'pull'}
            onclick={() => switchTab('pull')}
          >
            PRs
            <span class="font-mono text-2xs text-dim">{counts.pull}</span>
          </button>
          <button
            class="shrink-0 rounded-md px-1.5 py-0.5 text-xs hover:bg-hover"
            class:text-default={github.tab === 'issue'}
            class:text-dim={github.tab !== 'issue'}
            onclick={() => switchTab('issue')}
          >
            Issues
            <span class="font-mono text-2xs text-dim">{counts.issue}</span>
          </button>

          <input
            class="min-w-0 flex-1 rounded-md border border-line bg-input px-2 py-0.5 font-mono text-2xs text-default outline-none placeholder:font-sans placeholder:text-xs placeholder:text-dim focus:border-line-strong"
            placeholder="is:open label:bug"
            title={SEARCH_HELP}
            spellcheck="false"
            bind:value={github.query}
          />

          <button
            class="shrink-0 rounded p-1 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
            disabled={github.loading}
            title={refreshTitle}
            aria-label="Refresh"
            onclick={() => refreshDashboard(github.stateFilter)}
          >
            <ArrowClockwiseIcon size={13} />
          </button>
          <button
            class="shrink-0 rounded p-1 text-dim hover:bg-hover hover:text-default"
            title="New issue"
            aria-label="New issue"
            onclick={startCompose}
          >
            <PlusIcon size={13} />
          </button>
        </div>

        <GithubFilterBar {setStateFilter} />

        <FloatingScrollbar class="min-h-0 flex-1">
          <div>
            {#each items as item (item.kind + item.number)}
              <GithubItemRow
                {item}
                selected={isSelected(item.number, item.kind)}
                checked={github.checked.includes(item.number)}
                isViewer={item.author === viewer}
                onselect={() => openItem(item.kind, item.number)}
                ontoggle={() => toggleChecked(item.number)}
              />
            {/each}

            {#if items.length === 0}
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
          </div>
        </FloatingScrollbar>
      </div>
    {/if}

    {#if !narrow || detailColumnShown}
      <div class="flex min-h-0 min-w-0 flex-1 flex-col border-line" class:border-l={!narrow}>
        {#if narrow && detailColumnShown}
          <button
            class="border-b border-line px-3 py-1.5 text-left text-2xs text-dim hover:bg-hover"
            onclick={backToList}
          >
            ← Back to list
          </button>
        {/if}
        <div class="min-h-0 flex-1">
          {#if github.composing}
            <GithubCompose />
          {:else}
            <GithubThread />
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
