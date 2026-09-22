<script lang="ts">
  // The worktree's stashes. Each expands like a commit into the files it holds;
  // hover offers applying it (keeping it), popping it (dropping it once
  // applied), or dropping it. The header stashes everything uncommitted.
  import ArchiveIcon from 'phosphor-svelte/lib/ArchiveIcon'
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon'
  import ArrowLineDownIcon from 'phosphor-svelte/lib/ArrowLineDownIcon'
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon'
  import CommitRow from './CommitRow.svelte'
  import GitSection from './GitSection.svelte'
  import RowAction from './RowAction.svelte'
  import { store } from '../../../lib/store.svelte'
  import { applyStash, dropStash, stashChanges } from './refActions'
  import type { StashEntry } from '../../../../../shared/types'

  let {
    worktreeId,
    hasChanges,
    refreshKey,
    onChanged
  }: {
    worktreeId: string
    hasChanges: boolean
    refreshKey: number
    onChanged: () => void
  } = $props()

  let stashes = $state<StashEntry[]>([])
  let open = $state(false)

  /** Re-reads the stash list. */
  async function load(): Promise<void> {
    try {
      stashes = await window.workbench.git.stashes(worktreeId)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Runs a stash action and reloads the view when it changed anything. */
  async function run(action: () => Promise<boolean>): Promise<void> {
    if (await action()) onChanged()
  }

  $effect(() => {
    void worktreeId
    void refreshKey
    void load()
  })
</script>

<GitSection title="Stashes" count={stashes.length} bind:open>
  {#snippet actions()}
    <RowAction
      icon={ArchiveIcon}
      title="Stash all changes"
      disabled={!hasChanges}
      onclick={() => run(() => stashChanges(worktreeId))}
    />
  {/snippet}

  <div role="tree">
    {#each stashes as stash (stash.commit.sha)}
      <CommitRow {worktreeId} commit={stash.commit} direction={null}>
        {#snippet actions()}
          <RowAction
            icon={DownloadSimpleIcon}
            title="Apply, keeping the stash"
            onclick={() => run(() => applyStash(worktreeId, stash, false))}
          />
          <RowAction
            icon={ArrowLineDownIcon}
            title="Pop: apply and drop"
            onclick={() => run(() => applyStash(worktreeId, stash, true))}
          />
          <RowAction
            icon={TrashIcon}
            title="Drop"
            onclick={() => run(() => dropStash(worktreeId, stash))}
          />
        {/snippet}
      </CommitRow>
    {:else}
      <p class="px-3 py-2 text-xs text-dim">No stashes.</p>
    {/each}
  </div>
</GitSection>
