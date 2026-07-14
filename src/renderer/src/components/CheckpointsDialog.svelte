<script lang="ts">
  // Local checkpoint timeline for a worktree: the automatic snapshots taken on
  // each agent turn / user message, plus manual ones. Restoring reverts the
  // working tree to that snapshot (the backend checkpoints first, so it's
  // reversible). Live-updates while open via the checkpoints event.
  import { refreshDiffStats } from '../lib/store.svelte'
  import type { CheckpointMeta } from '../../../shared/types'

  let { worktree, onClose }: { worktree: { id: string; name: string }; onClose: () => void } =
    $props()

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

  async function load(): Promise<void> {
    try {
      checkpoints = await window.workbench.checkpoints.list(worktree.id)
    } catch (err) {
      localError = (err as Error).message
    }
  }

  // Load once and refresh live while the dialog is open.
  $effect(() => {
    void load()
    const off = window.workbench.on('event:checkpoints', () => void load())
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
    const confirmed = confirm(
      'Restore the working tree to this checkpoint? Current uncommitted changes will be checkpointed first, then replaced.'
    )
    if (!confirmed) return
    busy = true
    localError = null
    try {
      await window.workbench.checkpoints.restore(worktree.id, commit)
      void refreshDiffStats(worktree.id)
      await load()
    } catch (err) {
      localError = (err as Error).message
    } finally {
      busy = false
    }
  }
</script>

<div
  class="fixed inset-0 z-modal flex items-center justify-center bg-black/60"
  role="button"
  tabindex="0"
  onclick={onClose}
  onkeydown={(event) => event.key === 'Escape' && onClose()}
>
  <div
    class="flex max-h-[80vh] w-[32rem] flex-col rounded-lg border border-line bg-surface p-4 shadow-lg"
    role="dialog"
    tabindex="0"
    onclick={(event) => event.stopPropagation()}
    onkeydown={() => {}}
  >
    <h2 class="mb-1 text-sm font-semibold">Checkpoints — {worktree.name}</h2>
    <p class="mb-3 text-2xs text-dim">
      Local-only snapshots. Restoring reverts uncommitted changes; it never touches commits or the
      branch.
    </p>

    {#if localError}
      <p class="mb-2 text-xs text-red">{localError}</p>
    {/if}

    <div class="min-h-0 flex-1 overflow-auto">
      {#if checkpoints.length === 0}
        <p class="py-6 text-center text-xs text-dim">
          No checkpoints yet. They're taken automatically as agents work.
        </p>
      {:else}
        {#each [...checkpoints].reverse() as checkpoint (checkpoint.commit)}
          <div class="flex items-center gap-2 border-b border-line py-2">
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
              class="shrink-0 rounded-md border border-line px-2 py-1 text-2xs text-dim hover:bg-hover disabled:opacity-50"
              disabled={busy}
              onclick={() => restore(checkpoint.commit)}
            >
              Restore
            </button>
          </div>
        {/each}
      {/if}
    </div>

    <div class="mt-3 flex justify-end">
      <button class="rounded-md px-3 py-1.5 text-xs text-dim hover:text-default" onclick={onClose}>
        Close
      </button>
    </div>
  </div>
</div>
