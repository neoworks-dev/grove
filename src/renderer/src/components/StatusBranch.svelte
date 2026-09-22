<script lang="ts">
  import GitBranch from 'phosphor-svelte/lib/GitBranch'
  import GitCommit from 'phosphor-svelte/lib/GitCommit'
  import { store } from '../lib/store.svelte'

  // The chip names the branch of the worktree on screen. `repo.currentBranch` is
  // read once when the repo opens and describes the top-level folder only, so it
  // is the fallback for before a worktree is selected, not the source.
  const worktree = $derived(store.selectedWorktree)

  const label = $derived.by(() => {
    if (worktree) return worktree.branch
    if (store.repo) return store.repo.currentBranch
    return null
  })
</script>

{#if label}
  <span class="flex items-center gap-1 font-mono">
    {#if worktree && worktree.isDetached}
      <GitCommit width="12" height="12" />
    {:else}
      <GitBranch width="12" height="12" />
    {/if}
    {label}
  </span>
{/if}
