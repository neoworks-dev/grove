<script lang="ts">
  // The Git pane's Repository tab, laid out around the commit graph the way
  // GitKraken lays its window out: the branch and the sync buttons across the
  // top, the refs and the rest of the repository down the left, and the graph
  // with whatever row is selected beside it.
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon'
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon'
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon'
  import CloudArrowDownIcon from 'phosphor-svelte/lib/CloudArrowDownIcon'
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon'
  import EdgePanel from '../../../components/EdgePanel.svelte'
  import RowAction from '../../../components/RowAction.svelte'
  import { store } from '../../../lib/store.svelte'
  import GitGraphPane from './graph/GitGraphPane.svelte'
  import RefsColumn from './changes/RefsColumn.svelte'
  import { gitState } from './state.svelte'
  import type { BranchStatus } from '../../../../../shared/types'

  let {
    state: paneState,
    updateState
  }: {
    state: Record<string, unknown>
    updateState: (patch: Record<string, unknown>) => void
  } = $props()

  // The left column's width until it is dragged, and the narrowest it goes.
  const REFS_WIDTH = 220
  const REFS_MIN_WIDTH = 160
  // Below this the left column is left out, so the graph and the selected
  // row's panel keep their room.
  const REFS_MIN_PANE_WIDTH = 640

  let refsWidth = $state(initialRefsWidth())
  let syncing = $state(false)
  let paneWidth = $state(0)

  const worktreeId = $derived(store.selectedWorktreeId)
  const worktreePath = $derived(store.selectedWorktree?.path)
  const branchStatus = $derived(gitState.branchStatus)
  const branchName = $derived.by(() => {
    if (branchStatus) return branchStatus.branch
    if (store.selectedWorktree) return store.selectedWorktree.branch
    return ''
  })

  /** The left column's width as last dragged in this pane, or the default. */
  function initialRefsWidth(): number {
    const saved = paneState.refsWidth
    if (typeof saved === 'number') return saved
    return REFS_WIDTH
  }

  /** Remembers a dragged left column width with the pane. */
  function saveRefsWidth(width: number): void {
    refsWidth = width
    updateState({ refsWidth: width })
  }

  /** Runs fetch, pull or push, then has every git view reload. */
  async function sync(action: (id: string) => Promise<string>): Promise<void> {
    const id = worktreeId
    if (!id) return
    syncing = true
    try {
      await action(id)
      await gitState.reload()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      syncing = false
    }
  }

  /** How the branch stands against its upstream, for the status tooltip. */
  function upstreamTitle(status: BranchStatus): string {
    if (!status.upstream) return 'No upstream branch'
    return `${status.ahead} ahead, ${status.behind} behind ${status.upstream}`
  }

  /** What pushing would do, for the push button's tooltip. */
  function pushTitle(status: BranchStatus | null): string {
    if (status && status.upstream) return `Push ${status.ahead} to ${status.upstream}`
    return 'Publish branch'
  }

  /** Whether there is nothing to push: the branch is published and not ahead. */
  function nothingToPush(status: BranchStatus | null): boolean {
    if (!status || !status.upstream) return false
    return status.ahead === 0
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden text-xs" bind:clientWidth={paneWidth}>
  <div class="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-2">
    <GitBranchIcon size={12} class="shrink-0 text-dim" />
    <span class="min-w-0 truncate font-mono text-default" title={branchName}>{branchName}</span>
    {#if branchStatus && branchStatus.upstream}
      <span
        class="flex shrink-0 items-center gap-1 font-mono text-2xs text-dim"
        title={upstreamTitle(branchStatus)}
      >
        {#if branchStatus.ahead > 0}
          <span class="flex items-center"><ArrowUpIcon size={10} />{branchStatus.ahead}</span>
        {/if}
        {#if branchStatus.behind > 0}
          <span class="flex items-center"><ArrowDownIcon size={10} />{branchStatus.behind}</span>
        {/if}
        {#if branchStatus.ahead === 0 && branchStatus.behind === 0}
          <span>in sync</span>
        {/if}
      </span>
    {:else if branchStatus}
      <span class="shrink-0 text-2xs text-faint" title={upstreamTitle(branchStatus)}>
        not published
      </span>
    {/if}
    <span class="flex-1"></span>
    <RowAction
      icon={CloudArrowDownIcon}
      title="Fetch"
      disabled={syncing}
      onclick={() => sync(window.workbench.git.fetch)}
    />
    {#if branchStatus && branchStatus.upstream}
      <RowAction
        icon={ArrowDownIcon}
        title="Pull {branchStatus.behind} from {branchStatus.upstream}"
        disabled={syncing || branchStatus.behind === 0}
        onclick={() => sync(window.workbench.git.pull)}
      />
    {/if}
    <RowAction
      icon={ArrowUpIcon}
      title={pushTitle(branchStatus)}
      disabled={syncing || nothingToPush(branchStatus)}
      onclick={() => sync(window.workbench.git.push)}
    />
    <RowAction
      icon={ArrowClockwiseIcon}
      title="Refresh"
      disabled={gitState.loading}
      onclick={() => void gitState.reload()}
    />
  </div>

  <div class="flex min-h-0 flex-1">
    {#if worktreeId && worktreePath && paneWidth >= REFS_MIN_PANE_WIDTH}
      <EdgePanel
        side="right"
        bind:size={() => refsWidth, saveRefsWidth}
        min={REFS_MIN_WIDTH}
        class="border-r border-line"
      >
        <RefsColumn {worktreeId} {worktreePath} currentBranch={branchName} />
      </EdgePanel>
    {/if}
    <div class="min-w-0 flex-1">
      <GitGraphPane state={paneState} {updateState} />
    </div>
  </div>
</div>
