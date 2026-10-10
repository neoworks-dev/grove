<script lang="ts">
  // The worktree's safety snapshots: what Grove saved before a merge, rebase,
  // reset or restore rewrote the files. Each row says what triggered it and
  // when; hover offers restoring it, which resets the worktree's files to that
  // snapshot after taking a new one, so the restore can itself be undone.
  import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon'
  import GitSection from './GitSection.svelte'
  import RowAction from './RowAction.svelte'
  import { triggerLabel, visibleCheckpoints } from './checkpointRows'
  import { dialogs } from '../../../lib/dialogs.svelte'
  import { store, refreshDiffStats } from '../../../lib/store.svelte'
  import { relativeTime } from '../../../lib/time'
  import type { CheckpointMeta } from '../../../../../shared/types'

  let {
    worktreeId,
    refreshKey,
    onChanged
  }: {
    worktreeId: string
    refreshKey: number
    onChanged: () => void
  } = $props()

  let checkpoints = $state<CheckpointMeta[]>([])
  let busy = $state(false)

  /** Re-reads the snapshots for the worktree. */
  async function load(): Promise<void> {
    try {
      checkpoints = visibleCheckpoints(await window.workbench.checkpoints.list(worktreeId))
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Asks, then resets the worktree's files to the snapshot. */
  async function restore(checkpoint: CheckpointMeta): Promise<void> {
    // The app's own dialog: a native one can leave the window without a text
    // cursor anywhere once it closes (#216).
    const picked = await dialogs.confirm({
      title: `Restore the snapshot "${triggerLabel(checkpoint.trigger)}"?`,
      body: "This resets the worktree's files to that snapshot, discarding what has changed since. A new snapshot is taken first, so you can come back to the current state.",
      actions: [
        { id: 'restore', label: 'Restore', kind: 'danger' },
        { id: 'cancel', label: 'Cancel' }
      ]
    })
    if (picked !== 'restore') return
    busy = true
    try {
      await window.workbench.checkpoints.restore(worktreeId, checkpoint.commit)
      void refreshDiffStats(worktreeId)
      onChanged()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  /** The row's tooltip: the snapshot's note, when it has one, and its date. */
  function details(checkpoint: CheckpointMeta): string {
    const date = new Date(checkpoint.ts).toLocaleString()
    if (!checkpoint.note) return date
    return `${checkpoint.note}\n${date}`
  }

  $effect(() => {
    void worktreeId
    void refreshKey
    void load()
    return window.workbench.on('event:checkpoints', () => void load())
  })
</script>

<GitSection title="Checkpoints" count={checkpoints.length} open={false}>
  <div role="list">
    {#each checkpoints as checkpoint (checkpoint.commit)}
      <div
        class="group/row flex w-full items-center gap-1 py-[3px] pr-2 pl-4 text-xs text-muted select-none hover:bg-hover"
        role="listitem"
        title={details(checkpoint)}
      >
        <span class="min-w-0 flex-1 truncate">{triggerLabel(checkpoint.trigger)}</span>
        <span class="shrink-0 font-mono text-2xs text-dim group-hover/row:hidden">
          {relativeTime(new Date(checkpoint.ts).toISOString())}
        </span>
        <span class="hidden shrink-0 group-hover/row:block">
          <RowAction
            icon={ClockCounterClockwiseIcon}
            title="Restore this snapshot"
            disabled={busy}
            onclick={() => restore(checkpoint)}
          />
        </span>
      </div>
    {:else}
      <p class="px-3 py-2 text-xs text-dim">
        No snapshots yet. Grove takes one before it merges, rebases or resets.
      </p>
    {/each}
  </div>
</GitSection>
