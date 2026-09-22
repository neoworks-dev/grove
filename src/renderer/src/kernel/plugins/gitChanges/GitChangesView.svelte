<script lang="ts">
  // The source-control view for the selected worktree, laid out the way GitLens
  // and VS Code lay theirs: the branch and how it stands against its upstream,
  // the commit box, then collapsible sections — staged, unstaged — as a tree or
  // a list. Clicking a file opens it with its hunks painted by the review
  // overlay; the ship-it chain lives in the footer.
  //
  // A merge in progress takes over both ends: its conflicts lead the sections,
  // and the footer offers finishing or abandoning the merge instead of the
  // commit box and the ship-it chain.
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon'
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon'
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon'
  import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwiseIcon'
  import TreeStructureIcon from 'phosphor-svelte/lib/TreeStructureIcon'
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { store } from '../../../lib/store.svelte'
  import { inlineEdit } from '../../../lib/inlineEdit.svelte'
  import { settings } from '../../../lib/settings.svelte'
  import CommitBox from './CommitBox.svelte'
  import ChangesList, { fileKey } from './ChangesList.svelte'
  import ConflictsSection from './ConflictsSection.svelte'
  import GitSection from './GitSection.svelte'
  import MergeBar from './MergeBar.svelte'
  import RowAction from './RowAction.svelte'
  import ShipItBar from './ShipItBar.svelte'
  import { LAYOUT_SETTING, type ChangesLayout } from './changeTree'
  import type { BranchStatus, DiffFile, MergeState } from '../../../../../shared/types'

  let allFiles = $state<DiffFile[]>([])
  let merge = $state<MergeState>({ inProgress: false, files: [] })
  let branchStatus = $state<BranchStatus | null>(null)
  let loading = $state(false)
  let selectedKey = $state<string | null>(null)
  let commitMessage = $state('')
  // Bumped after every load, so expanded file rows re-read their hunks.
  let refreshKey = $state(0)

  const worktreeId = $derived(store.selectedWorktreeId)
  const layout = $derived(settings.get<ChangesLayout>(LAYOUT_SETTING))

  // An unmerged path is reported by both `diff` and `diff --staged`, so it would
  // otherwise appear twice in the list — and neither entry means anything: the
  // file is a set of conflicts, not a change to review against HEAD.
  const conflictedPaths = $derived(new Set(merge.files.map((file) => file.path)))
  const files = $derived(allFiles.filter((file) => !conflictedPaths.has(file.path)))
  const stagedFiles = $derived(files.filter((file) => file.staged))
  const unstagedFiles = $derived(files.filter((file) => !file.staged))

  const branchName = $derived.by(() => {
    if (branchStatus) return branchStatus.branch
    if (store.selectedWorktree) return store.selectedWorktree.branch
    return ''
  })

  /** Re-reads the changes, the merge state and the branch for the selected worktree. */
  async function load(): Promise<void> {
    const id = store.selectedWorktreeId
    if (!id) {
      allFiles = []
      merge = { inProgress: false, files: [] }
      branchStatus = null
      return
    }
    loading = true
    try {
      const [changed, mergeState, status] = await Promise.all([
        window.workbench.git.changedFiles(id),
        window.workbench.git.mergeState(id),
        window.workbench.git.branchStatus(id)
      ])
      allFiles = changed
      merge = mergeState
      branchStatus = status
      refreshKey += 1
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      loading = false
    }
  }

  /** Opens a file with its uncommitted hunks painted by the review overlay. */
  async function reviewFile(file: DiffFile): Promise<void> {
    const id = store.selectedWorktreeId
    const root = store.selectedWorktree?.path
    if (!id || !root) return
    selectedKey = fileKey(file)
    // A deleted file has no buffer to review; selecting it is all there is.
    if (file.changeType === 'deleted') return
    await inlineEdit.reviewWorkingTreeFile(id, file, `${root}/${file.path}`)
  }

  /** Stages every unstaged change, or unstages every staged one. */
  async function toggleAll(staged: boolean): Promise<void> {
    const id = store.selectedWorktreeId
    if (!id) return
    try {
      if (staged)
        await window.workbench.git.unstage(
          id,
          stagedFiles.map((file) => file.path)
        )
      else
        await window.workbench.git.stage(
          id,
          unstagedFiles.map((file) => file.path)
        )
      await load()
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Switches between the tree and the list layout, for every worktree. */
  function toggleLayout(): void {
    let next: ChangesLayout = 'tree'
    if (layout === 'tree') next = 'list'
    void settings.set(LAYOUT_SETTING, next, 'user')
  }

  /** How the branch stands against its upstream, for the header's tooltip. */
  function upstreamTitle(status: BranchStatus): string {
    if (!status.upstream) return 'No upstream branch'
    return `${status.ahead} ahead, ${status.behind} behind ${status.upstream}`
  }

  // Reload on worktree switch and whenever the fs watcher reports a change.
  $effect(() => {
    void store.selectedWorktreeId
    void store.fsVersion[store.selectedWorktreeId ?? '']
    void load()
  })

  // An agent-touched file (fs watcher) is auto-selected for review context.
  $effect(() => {
    const requested = store.requestedDiffFile
    if (!requested) return
    store.requestedDiffFile = null
    const match = files.find((file) => file.path === requested)
    if (match) selectedKey = fileKey(match)
  })
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-1.5 px-3 py-2">
    <GitBranchIcon size={12} class="shrink-0 text-dim" />
    <span class="min-w-0 truncate font-mono text-xs text-default" title={branchName}>
      {branchName}
    </span>
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
    {#if layout === 'tree'}
      <RowAction icon={ListBulletsIcon} title="View as list" onclick={toggleLayout} />
    {:else}
      <RowAction icon={TreeStructureIcon} title="View as tree" onclick={toggleLayout} />
    {/if}
    <RowAction icon={ArrowsClockwiseIcon} title="Refresh" disabled={loading} onclick={load} />
  </div>

  {#if worktreeId && !merge.inProgress}
    <CommitBox
      {worktreeId}
      branch={branchName}
      stagedCount={stagedFiles.length}
      bind:message={commitMessage}
      onCommitted={load}
    />
  {/if}

  <FloatingScrollbar class="min-h-0 flex-1">
    <div>
      {#if worktreeId && merge.files.length > 0}
        <ConflictsSection {worktreeId} files={merge.files} onResolved={load} />
      {/if}

      {#if worktreeId && stagedFiles.length > 0}
        <GitSection title="Staged Changes" count={stagedFiles.length}>
          {#snippet actions()}
            <RowAction icon={MinusIcon} title="Unstage all" onclick={() => toggleAll(true)} />
          {/snippet}
          <ChangesList
            {worktreeId}
            files={stagedFiles}
            staged={true}
            {layout}
            {selectedKey}
            {refreshKey}
            onReview={reviewFile}
            onChanged={load}
          />
        </GitSection>
      {/if}

      {#if worktreeId && unstagedFiles.length > 0}
        <GitSection title="Changes" count={unstagedFiles.length}>
          {#snippet actions()}
            <RowAction icon={PlusIcon} title="Stage all" onclick={() => toggleAll(false)} />
          {/snippet}
          <ChangesList
            {worktreeId}
            files={unstagedFiles}
            staged={false}
            {layout}
            {selectedKey}
            {refreshKey}
            onReview={reviewFile}
            onChanged={load}
          />
        </GitSection>
      {/if}

      {#if !loading && files.length === 0 && merge.files.length === 0}
        <p class="px-3 py-4 text-xs text-dim">No changes vs HEAD.</p>
      {/if}
    </div>
  </FloatingScrollbar>

  {#if worktreeId && merge.inProgress}
    <MergeBar {worktreeId} unresolved={merge.files.length} onChanged={load} />
  {:else if worktreeId}
    <ShipItBar {worktreeId} {commitMessage} onChanged={load} />
  {/if}
</div>
