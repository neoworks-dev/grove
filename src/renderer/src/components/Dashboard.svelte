<script lang="ts">
  import { store, selectWorktree, refreshRuntimes } from '../lib/store.svelte'
  import type { ServiceRuntime, AgentRuntime } from '../../../shared/types'

  // Load runtimes for every worktree so the dashboard reflects all of them.
  async function refreshAll(): Promise<void> {
    for (const worktree of store.worktrees) {
      await refreshRuntimes(worktree.id)
    }
  }

  $effect(() => {
    store.worktrees.length
    void refreshAll()
  })

  function services(worktreeId: string): ServiceRuntime[] {
    return store.services[worktreeId] || []
  }
  function agents(worktreeId: string): AgentRuntime[] {
    return store.agents[worktreeId] || []
  }

  const statusColor: Record<string, string> = {
    running: 'bg-green',
    starting: 'bg-amber',
    unhealthy: 'bg-red',
    stopped: 'bg-neutral-600'
  }

  async function writeConfig(): Promise<void> {
    await window.workbench.config.writeSample()
    store.config = await window.workbench.config.load()
  }
</script>

<div class="h-full overflow-auto p-4">
  <div class="mb-4 flex items-center gap-3">
    <h1 class="text-lg font-semibold tracking-tight">Overview</h1>
    <button
      class="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover"
      onclick={refreshAll}>Refresh</button
    >
    {#if store.config && Object.keys(store.config.services).length === 0}
      <button
        class="rounded-md bg-action px-2 py-1 text-xs text-action-fg"
        onclick={writeConfig}
        title="Write a starter workbench.yaml"
      >
        Create sample config
      </button>
    {/if}
  </div>

  <div class="grid grid-cols-2 gap-3 xl:grid-cols-3">
    {#each store.worktrees as worktree (worktree.id)}
      <button
        class="rounded-lg border border-line bg-surface p-3 text-left hover:border-line-strong"
        onclick={() => selectWorktree(worktree.id)}
      >
        <div class="mb-2 flex items-center gap-2">
          <span
            class="h-2 w-2 rounded-full {worktree.dirty ? 'bg-amber' : 'bg-green'}"
            title={worktree.dirty ? 'dirty' : 'clean'}
          ></span>
          <span class="truncate font-medium">{worktree.name}</span>
          {#if worktree.isMain}
            <span class="rounded bg-raised px-1 text-2xs text-dim">main</span>
          {/if}
        </div>
        <div class="mb-2 truncate font-mono text-2xs text-dim">{worktree.branch}</div>
        <div class="mb-2 font-mono text-2xs text-dim">
          ports {store.config
            ? store.config.ports.start + worktree.portSlot * store.config.ports.count_per_worktree
            : '—'}+
        </div>

        <div class="mb-1 text-2xs uppercase tracking-caps text-dim">Services</div>
        <div class="mb-2 flex flex-wrap gap-1">
          {#each services(worktree.id) as service (service.name)}
            <span class="flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-2xs">
              <span class="h-1.5 w-1.5 rounded-full {statusColor[service.status]}"></span>
              {service.name}
            </span>
          {/each}
          {#if services(worktree.id).length === 0}
            <span class="text-2xs text-dim">none</span>
          {/if}
        </div>

        <div class="mb-1 text-2xs uppercase tracking-caps text-dim">Agents</div>
        <div class="flex flex-wrap gap-1">
          {#each agents(worktree.id).filter((agent) => agent.status === 'running') as agent (agent.name)}
            <span class="rounded bg-violet/20 px-1.5 py-0.5 text-2xs text-violet">{agent.name}</span>
          {/each}
          {#if agents(worktree.id).filter((agent) => agent.status === 'running').length === 0}
            <span class="text-2xs text-dim">idle</span>
          {/if}
        </div>
      </button>
    {/each}
  </div>
</div>
