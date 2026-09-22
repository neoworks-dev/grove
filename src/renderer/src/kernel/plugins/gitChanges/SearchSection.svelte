<script lang="ts">
  // Searching history across every branch and tag. The box takes GitLens's
  // operators — a bare word searches messages — and every term has to match.
  // Results are listed like the commits section's, a page at a time.
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import CommitRow from './CommitRow.svelte'
  import GitSection from './GitSection.svelte'
  import RowAction from './RowAction.svelte'
  import { store } from '../../../lib/store.svelte'
  import type { CommitSummary } from '../../../../../shared/types'

  let { worktreeId }: { worktreeId: string } = $props()

  const PAGE_SIZE = 50

  // Read once and then never again, so a hover title rather than a panel.
  const SEARCH_HELP = [
    'Every term has to match; case is ignored.',
    'word or "a phrase"   in the message',
    '@:name               author',
    '#:sha                a commit',
    '?:path               a file path containing it',
    '~:regex              lines added or removed (git log -G)',
    'Long forms: message: author: commit: file: change:'
  ].join('\n')

  let query = $state('')
  // The query the results are for; the box can have moved on since.
  let searched = $state('')
  let results = $state<CommitSummary[]>([])
  let hasMore = $state(false)
  let busy = $state(false)
  let open = $state(false)

  /** Runs the search in the box from its first page. */
  async function search(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const text = query.trim()
    if (text.length === 0) {
      clear()
      return
    }
    busy = true
    try {
      const page = await window.workbench.git.searchCommits(worktreeId, text, 0, PAGE_SIZE)
      results = page.commits
      hasMore = page.hasMore
      searched = text
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  /** Appends the next page of results. */
  async function loadMore(): Promise<void> {
    try {
      const page = await window.workbench.git.searchCommits(
        worktreeId,
        searched,
        results.length,
        PAGE_SIZE
      )
      results = [...results, ...page.commits]
      hasMore = page.hasMore
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Empties the box and the results. */
  function clear(): void {
    query = ''
    searched = ''
    results = []
    hasMore = false
  }

  // Results belong to the repository they were searched in.
  $effect(() => {
    void worktreeId
    clear()
  })
</script>

<GitSection title="Search Commits" count={results.length} bind:open>
  {#snippet actions()}
    <RowAction icon={XIcon} title="Clear search" disabled={searched === ''} onclick={clear} />
  {/snippet}

  <form class="px-2 pt-1 pb-2" onsubmit={search}>
    <input
      bind:value={query}
      class="w-full rounded-sm border border-line bg-input px-1.5 py-0.5 text-xs text-default outline-none placeholder:text-faint focus:border-line-strong"
      placeholder="Message, @:author, #:sha, ?:file, ~:change"
      title={SEARCH_HELP}
      spellcheck="false"
      aria-label="Search commits"
      onkeydown={(event) => event.key === 'Escape' && clear()}
    />
  </form>

  <div role="tree">
    {#if busy}
      <p class="px-3 pb-2 text-2xs text-dim">Searching…</p>
    {:else if searched !== ''}
      {#each results as commit (commit.sha)}
        <CommitRow {worktreeId} {commit} direction={null} />
      {:else}
        <p class="px-3 pb-2 text-2xs text-dim">No commits match.</p>
      {/each}
      {#if hasMore}
        <button
          class="w-full py-1 pl-9 text-left text-2xs text-dim hover:bg-hover hover:text-default"
          onclick={loadMore}
        >
          Load more…
        </button>
      {/if}
    {/if}
  </div>
</GitSection>
