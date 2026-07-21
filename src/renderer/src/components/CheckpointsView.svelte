<script lang="ts">
  // Local checkpoint timeline for the selected worktree, docked in the left
  // sidebar. Automatic snapshots (each agent turn / user message) plus manual
  // ones; restoring reverts the working tree to that snapshot (the backend
  // checkpoints first, so it's reversible). Follows the selected worktree and
  // live-updates via the checkpoints event.
  import { store, refreshDiffStats } from '../lib/store.svelte'
  import type { CheckpointMeta } from '../../../shared/types'

  const worktree = $derived(store.selectedWorktree)

  let checkpoints = $state<CheckpointMeta[]>([])
  let busy = $state(false)
  let localError = $state<string | null>(null)

  const triggerLabel: Record<CheckpointMeta['trigger'], string> = {
    'agent-turn-end': 'agent turn',
    'user-message': 'your message',
    'pre-restore': 'before restore',
    'pre-merge': 'before merge',
    manual: 'manual'
  }

  async function load(id: string): Promise<void> {
    try {
      checkpoints = await window.workbench.checkpoints.list(id)
    } catch (err) {
      localError = (err as Error).message
    }
  }

  // Reload on worktree switch and live while shown.
  $effect(() => {
    const id = worktree?.id
    if (!id) {
      checkpoints = []
      return
    }
    void load(id)
    const off = window.workbench.on('event:checkpoints', () => void load(id))
    return off
  })

  function relativeTime(ts: number): string {
    const seconds = Math.round((Date.now() - ts) / 1000)
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.round(hours / 24)}d ago`
  }

  async function restore(commit: string): Promise<void> {
    const id = worktree?.id
    if (!id) return
    const confirmed = confirm(
      'Restore the working tree to this checkpoint? Current uncommitted changes will be checkpointed first, then replaced.'
    )
    if (!confirmed) return
    busy = true
    localError = null
    try {
      await window.workbench.checkpoints.restore(id, commit)
      void refreshDiffStats(id)
      await load(id)
    } catch (err) {
      localError = (err as Error).message
    } finally {
      busy = false
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex items-center justify-between px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Checkpoints</span>
    {#if worktree}
      <span class="truncate text-2xs text-dim">{worktree.name}</span>
    {/if}
  </div>

  {#if localError}
    <p class="px-3 pb-2 text-xs text-red">{localError}</p>
  {/if}

  <div class="min-h-0 flex-1 overflow-auto">
    {#if !worktree}
      <p class="px-3 py-4 text-xs text-dim">Select a worktree to see its checkpoints.</p>
    {:else if checkpoints.length === 0}
      <p class="px-3 py-4 text-xs text-dim">
        No checkpoints yet. They're taken automatically as agents work.
      </p>
    {:else}
      {#each [...checkpoints].reverse() as checkpoint (checkpoint.commit)}
        <div class="group flex items-center gap-2 border-b border-line px-3 py-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-xs">
              <span class="font-mono text-violet">#{checkpoint.n}</span>
              <span class="text-default">{triggerLabel[checkpoint.trigger]}</span>
              {#if checkpoint.agent}
                <span class="rounded bg-raised px-1 text-2xs text-dim">{checkpoint.agent}</span>
              {/if}
            </div>
            {#if checkpoint.note}
              <div class="truncate text-2xs text-dim">{checkpoint.note}</div>
            {/if}
            <div class="font-mono text-2xs text-dim">
              {checkpoint.commit.slice(0, 7)} · {relativeTime(checkpoint.ts)}
            </div>
          </div>
          <button
            class="hidden shrink-0 rounded-md border border-line px-2 py-1 text-2xs text-dim hover:bg-hover disabled:opacity-50 group-hover:block"
            disabled={busy}
            onclick={() => restore(checkpoint.commit)}
          >
            Restore
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>
