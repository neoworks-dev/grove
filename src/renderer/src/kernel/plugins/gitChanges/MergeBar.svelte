<script lang="ts">
  // The footer while a merge is open, in place of the ship-it chain: a merge is
  // not something to commit or push through, it is something to finish or throw
  // away. It stays after the last conflict is resolved, because that is when
  // finishing it is the only move left.
  import { store, refreshWorktrees, refreshDiffStats } from '../../../lib/store.svelte'

  let {
    worktreeId,
    unresolved,
    onChanged
  }: { worktreeId: string; unresolved: number; onChanged: () => void } = $props()

  let busy = $state(false)
  let message = $state<string | null>(null)

  async function finish(): Promise<void> {
    busy = true
    message = null
    try {
      const result = await window.workbench.git.mergeContinue(worktreeId)
      if (result.status === 'conflict') message = `Still conflicted: ${result.files.join(', ')}`
      else message = 'Merge committed.'
      await refreshWorktrees()
      void refreshDiffStats(worktreeId)
      onChanged()
    } catch (err) {
      message = (err as Error).message
    } finally {
      busy = false
    }
  }

  async function abort(): Promise<void> {
    busy = true
    message = null
    try {
      await window.workbench.git.mergeAbort(worktreeId)
      await refreshWorktrees()
      void refreshDiffStats(worktreeId)
      onChanged()
    } catch (err) {
      message = (err as Error).message
    } finally {
      busy = false
    }
  }

  const branch = $derived(store.worktrees.find((worktree) => worktree.id === worktreeId)?.branch)
</script>

<div class="border-t border-line px-3 py-2">
  <p class="mb-2 text-2xs text-dim">
    Merging into <span class="font-mono text-default">{branch}</span> ·
    {#if unresolved === 0}
      <span class="text-green">all conflicts resolved</span>
    {:else}
      <span class="text-red">
        {unresolved} file{unresolved === 1 ? '' : 's'} left
      </span>
    {/if}
  </p>

  <div class="flex items-center gap-1">
    <button
      class="rounded bg-action px-2 py-1 text-2xs text-action-fg disabled:opacity-50"
      disabled={busy || unresolved > 0}
      title={unresolved > 0 ? 'Resolve every conflict first' : 'Commit the merge'}
      onclick={finish}
    >
      Continue merge
    </button>
    <button
      class="ml-auto rounded border border-line px-2 py-1 text-2xs text-red hover:bg-hover disabled:opacity-50"
      disabled={busy}
      onclick={abort}
    >
      Abort merge
    </button>
  </div>

  {#if message}
    <p class="mt-2 text-2xs text-dim">{message}</p>
  {/if}
</div>
