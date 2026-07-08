<script lang="ts">
  import { store, refreshWorktrees, selectWorktree } from '../lib/store.svelte'

  let { onClose }: { onClose: () => void } = $props()

  let name = $state('')
  let baseBranch = $state(store.config?.workbench.default_base_branch || 'main')
  let newBranch = $state('')
  let creating = $state(false)
  let localError = $state<string | null>(null)

  const branchOptions = $derived(store.branches?.all || [])

  async function submit(): Promise<void> {
    localError = null
    if (!name.trim()) {
      localError = 'Worktree name is required'
      return
    }
    creating = true
    try {
      const created = await window.workbench.worktrees.create({
        name: name.trim(),
        baseBranch,
        newBranch: newBranch.trim() || undefined
      })
      await refreshWorktrees()
      await selectWorktree(created.id)
      onClose()
    } catch (err) {
      localError = (err as Error).message
    } finally {
      creating = false
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
    class="w-96 rounded-lg border border-line bg-surface p-4 shadow-lg"
    role="dialog"
    tabindex="0"
    onclick={(event) => event.stopPropagation()}
    onkeydown={() => {}}
  >
    <h2 class="mb-3 text-sm font-semibold">New Worktree</h2>

    <label class="mb-1 block text-xs text-muted" for="wt-name">Name (directory)</label>
    <input
      id="wt-name"
      class="mb-3 w-full rounded-md border border-line bg-input px-2 py-1.5 text-sm"
      bind:value={name}
      placeholder="feature-x"
    />

    <label class="mb-1 block text-xs text-muted" for="wt-base">Base branch</label>
    <select
      id="wt-base"
      class="mb-3 w-full rounded-md border border-line bg-input px-2 py-1.5 text-sm"
      bind:value={baseBranch}
    >
      {#each branchOptions as branch (branch)}
        <option value={branch}>{branch}</option>
      {/each}
    </select>

    <label class="mb-1 block text-xs text-muted" for="wt-newbranch">
      New branch name (optional)
    </label>
    <input
      id="wt-newbranch"
      class="mb-3 w-full rounded-md border border-line bg-input px-2 py-1.5 text-sm"
      bind:value={newBranch}
      placeholder="leave empty to check out base branch"
    />

    {#if localError}
      <p class="mb-2 text-xs text-red">{localError}</p>
    {/if}

    <div class="flex justify-end gap-2">
      <button class="rounded-md px-3 py-1.5 text-xs text-dim hover:text-default" onclick={onClose}>
        Cancel
      </button>
      <button
        class="rounded-md bg-action px-3 py-1.5 text-xs text-action-fg disabled:opacity-50"
        disabled={creating}
        onclick={submit}
      >
        {creating ? 'Creating…' : 'Create'}
      </button>
    </div>
  </div>
</div>
