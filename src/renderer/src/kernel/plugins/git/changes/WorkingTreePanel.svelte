<script lang="ts">
  // The working tree, shown beside the commit graph when its top row is
  // selected: the commit box, then the staged and unstaged changes as a tree or
  // a list, down to the hunk. Clicking a file opens it with its hunks painted by
  // the review overlay; the ship-it chain lives in the footer.
  //
  // A merge in progress takes over both ends: its conflicts lead the sections,
  // and the footer offers finishing or abandoning the merge instead of the
  // commit box and the ship-it chain.
  import TreeStructureIcon from 'phosphor-svelte/lib/TreeStructureIcon'
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { store } from '../../../../lib/store.svelte'
  import { inlineEdit } from '../../../../lib/inlineEdit.svelte'
  import { settings } from '../../../../lib/settings.svelte'
  import { gitState } from '../state.svelte'
  import { gitPane } from '../pane.svelte'
  import CommitBox from './CommitBox.svelte'
  import ChangesList, { fileKey } from './ChangesList.svelte'
  import ConflictsSection from './ConflictsSection.svelte'
  import GitSection from './GitSection.svelte'
  import MergeBar from './MergeBar.svelte'
  import RowAction from '../../../../components/RowAction.svelte'
  import ShipItBar from './ShipItBar.svelte'
  import { LAYOUT_SETTING, type ChangesLayout } from './changeTree'
  import type { DiffFile } from '../../../../../../shared/types'

  let { onClose }: { onClose: () => void } = $props()

  let selectedKey = $state<string | null>(null)

  const merge = $derived(gitState.merge)
  const loading = $derived(gitState.loading)
  // Bumped after every reload, so expanded file rows re-read their hunks.
  const refreshKey = $derived(gitState.revision)
  const worktreeId = $derived(store.selectedWorktreeId)
  const layout = $derived(settings.get<ChangesLayout>(LAYOUT_SETTING))

  // An unmerged path is reported by both `diff` and `diff --staged`, so it would
  // otherwise appear twice in the list — and neither entry means anything: the
  // file is a set of conflicts, not a change to review against HEAD.
  const conflictedPaths = $derived(new Set(merge.files.map((file) => file.path)))
  const files = $derived(gitState.files.filter((file) => !conflictedPaths.has(file.path)))
  const stagedFiles = $derived(files.filter((file) => file.staged))
  const unstagedFiles = $derived(files.filter((file) => !file.staged))

  const branchName = $derived.by(() => {
    if (gitState.branchStatus) return gitState.branchStatus.branch
    if (store.selectedWorktree) return store.selectedWorktree.branch
    return ''
  })

  /** Re-reads the shared git state, which every git view shows. */
  async function load(): Promise<void> {
    await gitState.reload()
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

  // An agent-touched file (fs watcher) is auto-selected for review context.
  $effect(() => {
    const requested = store.requestedDiffFile
    if (!requested) return
    store.requestedDiffFile = null
    const match = files.find((file) => file.path === requested)
    if (match) selectedKey = fileKey(match)
  })
</script>

<div class="flex h-full min-h-0 flex-col text-xs">
  <div class="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-2">
    <span class="min-w-0 flex-1 truncate text-muted">
      {#if merge.inProgress}
        Merge in progress
      {:else}
        Uncommitted changes
      {/if}
    </span>
    {#if layout === 'tree'}
      <RowAction icon={ListBulletsIcon} title="View as list" onclick={toggleLayout} />
    {:else}
      <RowAction icon={TreeStructureIcon} title="View as tree" onclick={toggleLayout} />
    {/if}
    <RowAction icon={XIcon} title="Close" onclick={onClose} />
  </div>

  {#if worktreeId && !merge.inProgress}
    <CommitBox
      {worktreeId}
      branch={branchName}
      stagedCount={stagedFiles.length}
      bind:subject={gitPane.commitSubject}
      bind:description={gitPane.commitDescription}
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
        <p class="px-3 py-3 text-xs text-dim">No changes vs HEAD.</p>
      {/if}
    </div>
  </FloatingScrollbar>

  {#if worktreeId && merge.inProgress}
    <MergeBar {worktreeId} unresolved={merge.files.length} onChanged={load} />
  {:else if worktreeId}
    <ShipItBar {worktreeId} commitMessage={gitPane.commitSubject} onChanged={load} />
  {/if}
</div>
