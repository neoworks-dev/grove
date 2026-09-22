<script lang="ts">
  // The checked-out branch's history, newest first, a page at a time. What the
  // upstream has that the branch lacks comes first, marked incoming; commits
  // the upstream lacks are marked outgoing. Fetch, pull and push sit on the
  // header, since this is where their effect shows.
  import CloudArrowDownIcon from 'phosphor-svelte/lib/CloudArrowDownIcon'
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon'
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon'
  import { untrack } from 'svelte'
  import CommitRow from './CommitRow.svelte'
  import GitSection from './GitSection.svelte'
  import RowAction from './RowAction.svelte'
  import { store } from '../../../lib/store.svelte'
  import type { BranchStatus, CommitSummary } from '../../../../../shared/types'

  let {
    worktreeId,
    branchStatus,
    refreshKey,
    onChanged
  }: {
    worktreeId: string
    branchStatus: BranchStatus | null
    refreshKey: number
    onChanged: () => void
  } = $props()

  const PAGE_SIZE = 50

  let commits = $state<CommitSummary[]>([])
  let incoming = $state<CommitSummary[]>([])
  let unpushed = $state<Set<string>>(new Set())
  let hasMore = $state(false)
  let busy = $state(false)
  let open = $state(true)

  /** Re-reads the first page, and as many more as were already showing. */
  async function load(): Promise<void> {
    // Untracked: the effect below calls this, and the assignment further down
    // would otherwise re-run it forever.
    const shown = untrack(() => Math.max(PAGE_SIZE, commits.length))
    try {
      const result = await window.workbench.git.branchCommits(worktreeId, 0, shown)
      commits = result.commits
      incoming = result.incoming
      unpushed = new Set(result.unpushed)
      hasMore = result.hasMore
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Appends the next page of history. */
  async function loadMore(): Promise<void> {
    try {
      const result = await window.workbench.git.branchCommits(worktreeId, commits.length, PAGE_SIZE)
      commits = [...commits, ...result.commits]
      hasMore = result.hasMore
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Runs fetch, pull or push, then has the whole view reload. */
  async function sync(action: (id: string) => Promise<string>): Promise<void> {
    busy = true
    try {
      await action(worktreeId)
      onChanged()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  /** Whether a commit on the branch still has to be pushed. */
  function directionOf(commit: CommitSummary): 'outgoing' | null {
    if (unpushed.has(commit.sha)) return 'outgoing'
    return null
  }

  /** What pushing would do, for the push button's tooltip. */
  function pushTitle(status: BranchStatus | null): string {
    if (status && status.upstream) return `Push ${status.ahead} to ${status.upstream}`
    return 'Publish branch'
  }

  $effect(() => {
    void worktreeId
    void refreshKey
    void load()
  })
</script>

<GitSection title="Commits" bind:open>
  {#snippet actions()}
    <RowAction
      icon={CloudArrowDownIcon}
      title="Fetch"
      disabled={busy}
      onclick={() => sync(window.workbench.git.fetch)}
    />
    {#if branchStatus && branchStatus.upstream}
      <RowAction
        icon={ArrowDownIcon}
        title="Pull {branchStatus.behind} from {branchStatus.upstream}"
        disabled={busy || branchStatus.behind === 0}
        onclick={() => sync(window.workbench.git.pull)}
      />
    {/if}
    <RowAction
      icon={ArrowUpIcon}
      title={pushTitle(branchStatus)}
      disabled={busy || unpushed.size === 0}
      onclick={() => sync(window.workbench.git.push)}
    />
  {/snippet}

  <div role="tree">
    {#each incoming as commit (commit.sha)}
      <CommitRow {worktreeId} {commit} direction="incoming" />
    {/each}
    {#each commits as commit (commit.sha)}
      <CommitRow {worktreeId} {commit} direction={directionOf(commit)} />
    {:else}
      <p class="px-3 py-2 text-xs text-dim">No commits yet.</p>
    {/each}
    {#if hasMore}
      <button
        class="w-full py-1 pl-9 text-left text-2xs text-dim hover:bg-hover hover:text-default"
        onclick={loadMore}
      >
        Load more…
      </button>
    {/if}
  </div>
</GitSection>
