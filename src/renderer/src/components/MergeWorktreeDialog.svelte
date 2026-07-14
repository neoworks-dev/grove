<script lang="ts">
  // Merge one worktree's branch into another. Picks a target, previews the
  // incoming commits, warns about uncommitted source work, runs the merge (the
  // backend checkpoints the target first), and surfaces conflicts with an abort.
  import { store, refreshWorktrees, refreshDiffStats } from '../lib/store.svelte'
  import type { MergePreview, MergeResult, MergeMode } from '../../../shared/types'

  let {
    source,
    onClose
  }: { source: { id: string; name: string; branch: string }; onClose: () => void } = $props()

  // Valid targets: every other worktree.
  const targets = $derived(store.worktrees.filter((worktree) => worktree.id !== source.id))

  let targetId = $state(targets[0]?.id || '')
  let mode = $state<MergeMode>('no-ff')
  let preview = $state<MergePreview | null>(null)
  let previewing = $state(false)
  let merging = $state(false)
  let result = $state<MergeResult | null>(null)
  let localError = $state<string | null>(null)

  const target = $derived(store.worktrees.find((worktree) => worktree.id === targetId) || null)

  // Reload the preview whenever the chosen target changes.
  $effect(() => {
    const id = targetId
    if (!id) return
    void loadPreview(id)
  })

  async function loadPreview(id: string): Promise<void> {
    previewing = true
    localError = null
    result = null
    try {
      preview = await window.workbench.git.mergePreview(id, source.id)
    } catch (err) {
      preview = null
      localError = (err as Error).message
    } finally {
      previewing = false
    }
  }

  async function runMerge(): Promise<void> {
    if (!targetId) return
    merging = true
    localError = null
    try {
      result = await window.workbench.git.mergeWorktree(targetId, source.id, { mode })
      await refreshWorktrees()
      void refreshDiffStats(targetId)
    } catch (err) {
      localError = (err as Error).message
    } finally {
      merging = false
    }
  }

  async function abort(): Promise<void> {
    if (!targetId) return
    try {
      await window.workbench.git.mergeAbort(targetId)
      result = null
      await refreshWorktrees()
      void refreshDiffStats(targetId)
    } catch (err) {
      localError = (err as Error).message
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
    class="w-[32rem] rounded-lg border border-line bg-surface p-4 shadow-lg"
    role="dialog"
    tabindex="0"
    onclick={(event) => event.stopPropagation()}
    onkeydown={() => {}}
  >
    <h2 class="mb-3 text-sm font-semibold">
      Merge <span class="font-mono text-violet">{source.branch}</span> into…
    </h2>

    {#if targets.length === 0}
      <p class="text-xs text-dim">No other worktree to merge into.</p>
    {:else}
      <label class="mb-1 block text-xs text-muted" for="merge-target">Target worktree</label>
      <select
        id="merge-target"
        class="mb-3 w-full rounded-md border border-line bg-input px-2 py-1.5 text-sm"
        bind:value={targetId}
      >
        {#each targets as worktree (worktree.id)}
          <option value={worktree.id}>{worktree.name} ({worktree.branch})</option>
        {/each}
      </select>

      <div class="mb-3 flex items-center gap-2 text-xs">
        <span class="text-muted">Mode</span>
        {#each ['no-ff', 'ff', 'ff-only'] as option (option)}
          <button
            class="rounded-md border px-2 py-1 {mode === option
              ? 'border-violet bg-violet-soft text-violet'
              : 'border-line text-dim hover:bg-hover'}"
            onclick={() => (mode = option as MergeMode)}
          >
            {option}
          </button>
        {/each}
      </div>

      {#if previewing}
        <p class="mb-2 text-xs text-dim">Loading preview…</p>
      {:else if preview}
        {#if preview.alreadyMerged}
          <p class="mb-2 text-xs text-green">Already up to date — nothing to merge.</p>
        {:else}
          <div class="mb-2 rounded-md border border-line bg-canvas p-2">
            <div class="mb-1 text-2xs text-muted">
              {preview.commits.length} commit{preview.commits.length === 1 ? '' : 's'} · {preview.canFastForward
                ? 'fast-forward possible'
                : 'merge commit required'}
            </div>
            <div class="max-h-32 overflow-auto font-mono text-2xs">
              {#each preview.commits as commit (commit.sha)}
                <div class="truncate text-dim">
                  <span class="text-violet">{commit.sha.slice(0, 7)}</span>
                  {commit.subject}
                </div>
              {/each}
            </div>
          </div>
        {/if}
        {#if preview.sourceDirty}
          <p class="mb-2 text-xs text-amber">
            ⚠ {source.name} has uncommitted changes that will NOT be included — commit them first if you
            need them.
          </p>
        {/if}
      {/if}

      {#if result}
        {#if result.status === 'merged'}
          <p class="mb-2 text-xs text-green">
            ✓ Merged{result.fastForward ? ' (fast-forward)' : ''}.
          </p>
        {:else if result.status === 'up-to-date'}
          <p class="mb-2 text-xs text-green">Already up to date.</p>
        {:else if result.status === 'conflict'}
          <div class="mb-2 rounded-md border border-red/40 bg-red-soft p-2">
            <div class="mb-1 text-xs text-red">
              Conflicts in {result.files.length} file{result.files.length === 1 ? '' : 's'}. Resolve
              them in {target?.name}, or abort.
            </div>
            <div class="max-h-24 overflow-auto font-mono text-2xs text-red">
              {#each result.files as file (file)}
                <div class="truncate">{file}</div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}

      {#if localError}
        <p class="mb-2 text-xs text-red">{localError}</p>
      {/if}

      <div class="flex justify-end gap-2">
        <button
          class="rounded-md px-3 py-1.5 text-xs text-dim hover:text-default"
          onclick={onClose}
        >
          Close
        </button>
        {#if result?.status === 'conflict'}
          <button
            class="rounded-md border border-line px-3 py-1.5 text-xs text-red hover:bg-hover"
            onclick={abort}
          >
            Abort merge
          </button>
        {:else}
          <button
            class="rounded-md bg-action px-3 py-1.5 text-xs text-action-fg disabled:opacity-50"
            disabled={merging || previewing || !targetId || preview?.alreadyMerged === true}
            onclick={runMerge}
          >
            {merging ? 'Merging…' : 'Merge'}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
