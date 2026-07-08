<script lang="ts">
  import { store, selectWorktree, refreshWorktrees } from '../lib/store.svelte'
  import CreateWorktreeDialog from './CreateWorktreeDialog.svelte'
  import type { Worktree, ServiceRuntime, AgentRuntime } from '../../../shared/types'

  let showDialog = $state(false)

  function serviceSummary(worktreeId: string): { running: number; total: number } {
    const list: ServiceRuntime[] = store.services[worktreeId] || []
    const running = list.filter((service) => service.status === 'running').length
    return { running, total: list.length }
  }

  function hasActiveAgent(worktreeId: string): boolean {
    const list: AgentRuntime[] = store.agents[worktreeId] || []
    return list.some((agent) => agent.status === 'running')
  }

  async function remove(worktree: Worktree, event: MouseEvent): Promise<void> {
    event.stopPropagation()
    const force = worktree.dirty
    const confirmed = confirm(
      `Remove worktree "${worktree.name}"?${force ? ' It has uncommitted changes (force).' : ''}`
    )
    if (!confirmed) return
    try {
      await window.workbench.worktrees.remove(worktree.id, force)
      await refreshWorktrees()
      if (store.selectedWorktreeId === worktree.id) {
        const next = store.worktrees[0]?.id
        if (next) await selectWorktree(next)
        else store.selectedWorktreeId = null
      }
    } catch (err) {
      store.setError((err as Error).message)
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center justify-between px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Worktrees</span>
    <button
      class="rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs hover:bg-hover disabled:opacity-40"
      disabled={!store.repo}
      onclick={() => (showDialog = true)}
      title="New worktree"
    >
      +
    </button>
  </div>

  <div class="flex-1 overflow-y-auto">
    {#each store.worktrees as worktree (worktree.id)}
      {@const summary = serviceSummary(worktree.id)}
      <div
        class="group flex cursor-pointer items-center gap-2 px-3 py-2 text-sm {store.selectedWorktreeId ===
        worktree.id
          ? 'bg-surface'
          : 'hover:bg-hover'}"
        role="button"
        tabindex="0"
        onclick={() => selectWorktree(worktree.id)}
        onkeydown={(event) => event.key === 'Enter' && selectWorktree(worktree.id)}
      >
        <span
          class="h-2 w-2 shrink-0 rounded-full {worktree.dirty ? 'bg-amber' : 'bg-green'}"
          title={worktree.dirty ? 'dirty' : 'clean'}
        ></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1">
            <span class="truncate">{worktree.name}</span>
            {#if worktree.isMain}
              <span class="rounded bg-raised px-1 text-2xs text-dim">main</span>
            {/if}
          </div>
          <div class="truncate font-mono text-2xs text-dim">{worktree.branch}</div>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          {#if summary.total > 0}
            <span
              class="text-2xs {summary.running > 0 ? 'text-green' : 'text-dim'}"
              title="running/total services"
            >
              {summary.running}/{summary.total}
            </span>
          {/if}
          {#if hasActiveAgent(worktree.id)}
            <span class="h-2 w-2 rounded-full bg-violet" title="agent running"></span>
          {/if}
          {#if !worktree.isMain}
            <button
              class="hidden text-dim hover:text-red group-hover:block"
              title="Remove worktree"
              onclick={(event) => remove(worktree, event)}
            >
              ✕
            </button>
          {/if}
        </div>
      </div>
    {/each}

    {#if store.repo && store.worktrees.length === 0}
      <p class="px-3 py-4 text-xs text-dim">No worktrees.</p>
    {/if}
  </div>
</div>

{#if showDialog}
  <CreateWorktreeDialog onClose={() => (showDialog = false)} />
{/if}
