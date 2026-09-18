<script lang="ts">
  // The GitHub pane: pull requests and issues for the open repository, side by
  // side with the selected item's thread. Loads on mount, then polls in the
  // background; the poll stops with the pane.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { github, refreshDashboard, selectItem, startAutoRefresh } from './store.svelte'
  import GithubItemRow from './GithubItemRow.svelte'
  import GithubThread from './GithubThread.svelte'
  import { ageLabel } from './filter'
  import type { GithubItemKind, GithubStateFilter } from '../../../../../shared/types'

  // Below this the pane shows one column at a time: the list, or the thread with
  // a way back.
  const NARROW_PX = 720

  let width = $state(0)
  const narrow = $derived(width > 0 && width < NARROW_PX)
  const items = $derived(github.items)
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
    void selectItem(null)
  }

  function setStateFilter(event: Event): void {
    github.stateFilter = (event.currentTarget as HTMLSelectElement).value as GithubStateFilter
  }

  function isSelected(number: number, kind: GithubItemKind): boolean {
    const selection = github.selection
    if (!selection) return false
    return selection.number === number && selection.kind === kind
  }
</script>

<div class="flex h-full min-h-0 flex-col" bind:clientWidth={width}>
  <div class="flex items-center gap-2 border-b border-line px-3 py-2">
    <button
      class="rounded-md px-2 py-1 text-xs hover:bg-hover"
      class:text-default={github.tab === 'pull'}
      class:text-dim={github.tab !== 'pull'}
      onclick={() => switchTab('pull')}
    >
      Pull requests
      <span class="font-mono text-2xs text-dim">{counts.pull}</span>
    </button>
    <button
      class="rounded-md px-2 py-1 text-xs hover:bg-hover"
      class:text-default={github.tab === 'issue'}
      class:text-dim={github.tab !== 'issue'}
      onclick={() => switchTab('issue')}
    >
      Issues
      <span class="font-mono text-2xs text-dim">{counts.issue}</span>
    </button>

    <input
      class="ml-2 min-w-0 flex-1 rounded-md border border-line bg-input px-2 py-1 text-xs text-default outline-none placeholder:text-dim focus:border-line-strong"
      placeholder="Filter by title, author, label, #number"
      bind:value={github.query}
    />

    <select
      class="rounded-md border border-line bg-input px-1.5 py-1 text-2xs text-dim outline-none"
      value={github.stateFilter}
      onchange={setStateFilter}
    >
      <option value="open">Open</option>
      <option value="closed">Closed</option>
      <option value="all">All</option>
    </select>

    {#if github.dashboard}
      <span class="shrink-0 text-2xs text-dim" title={github.dashboard.repo.nameWithOwner}>
        updated {ageLabel(new Date(github.dashboard.fetchedAt).toISOString())}
      </span>
    {/if}
    <button
      class="shrink-0 rounded-md border border-line px-2 py-1 text-2xs text-dim hover:bg-hover disabled:opacity-50"
      disabled={github.loading}
      onclick={() => refreshDashboard(github.stateFilter)}
    >
      Refresh
    </button>
  </div>

  {#if github.error}
    <p class="border-b border-line px-3 py-2 text-xs text-red">{github.error}</p>
  {/if}

  <div class="flex min-h-0 flex-1">
    {#if !narrow || !github.selection}
      <div class="flex min-h-0 min-w-0 shrink-0 flex-col" style:width={listWidth}>
        <FloatingScrollbar class="min-h-0 flex-1">
          <div>
            {#each items as item (item.kind + item.number)}
              <GithubItemRow
                {item}
                selected={isSelected(item.number, item.kind)}
                isViewer={item.author === viewer}
                onselect={() => selectItem({ kind: item.kind, number: item.number })}
              />
            {/each}

            {#if items.length === 0}
              <p class="px-3 py-4 text-xs text-dim">
                {#if github.loading}
                  Loading…
                {:else if github.query.trim().length > 0}
                  Nothing matches "{github.query}".
                {:else}
                  Nothing here.
                {/if}
              </p>
            {/if}
          </div>
        </FloatingScrollbar>
      </div>
    {/if}

    {#if !narrow || github.selection}
      <div class="flex min-h-0 min-w-0 flex-1 flex-col border-line" class:border-l={!narrow}>
        {#if narrow && github.selection}
          <button
            class="border-b border-line px-3 py-1.5 text-left text-2xs text-dim hover:bg-hover"
            onclick={() => selectItem(null)}
          >
            ← Back to list
          </button>
        {/if}
        <div class="min-h-0 flex-1">
          <GithubThread />
        </div>
      </div>
    {/if}
  </div>
</div>
