<script lang="ts">
  import { store, refreshWorktrees, selectWorktree } from '../../../lib/store.svelte'
  import { agentSessions } from '../../../lib/agents/sessions.svelte'
  import { startSessionWithTask } from '../../../lib/agents/newSession'

  let { onClose }: { onClose: () => void } = $props()

  let name = $state('')
  let baseBranch = $state(store.config?.workbench.default_base_branch || 'main')
  let newBranch = $state('')
  let task = $state('')
  let creating = $state(false)
  let localError = $state<string | null>(null)

  const branchOptions = $derived(store.branches?.all || [])

  /**
   * The branch the worktree gets, falling back to its name. Always a new branch: checking out
   * the base itself fails whenever the base is already checked out, as the default base is.
   */
  function branchForWorktree(): string {
    const branch = newBranch.trim()
    if (branch) {
      return branch
    }
    return name.trim()
  }

  /**
   * Creates the worktree on its own branch off the chosen base and selects it, then
   * starts an agent there on the task when one was given.
   */
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
        newBranch: branchForWorktree()
      })
      await refreshWorktrees()
      await selectWorktree(created.id)
      onClose()
      await startTask(created.path)
    } catch (err) {
      localError = (err as Error).message
    } finally {
      creating = false
    }
  }

  /**
   * Starts an agent in the new worktree on the task, if one was given. Runs after the
   * dialog has closed, so a failure goes to the app's error banner.
   */
  async function startTask(worktreePath: string): Promise<void> {
    const prompt = task.trim()
    if (!prompt) {
      return
    }
    try {
      const sessionId = await startSessionWithTask(worktreePath, prompt)
      if (!sessionId) {
        store.setError(agentSessions.serverError || 'Could not reach the agent server.')
      }
    } catch (err) {
      store.setError((err as Error).message)
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

    <label class="mb-1 block text-xs text-muted" for="wt-newbranch"> New branch </label>
    <input
      id="wt-newbranch"
      class="mb-3 w-full rounded-md border border-line bg-input px-2 py-1.5 text-sm"
      bind:value={newBranch}
      placeholder={name.trim() || 'defaults to the worktree name'}
    />

    <label class="mb-1 block text-xs text-muted" for="wt-task">Task (optional)</label>
    <textarea
      id="wt-task"
      class="mb-3 h-20 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-sm"
      bind:value={task}
      placeholder="Starts an agent in the new worktree"
    ></textarea>

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
