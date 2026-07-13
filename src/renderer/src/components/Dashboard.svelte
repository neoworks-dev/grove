<script lang="ts">
  import { onMount } from 'svelte'
  import { store, selectWorktree, refreshRuntimes } from '../lib/store.svelte'
  import {
    serviceStatusColor,
    agentStatusColor,
    attentionFor
  } from '../lib/worktreeStatus'
  import type { ServiceRuntime, AgentRuntime } from '../../../shared/types'

  // Runtime status arrives via push events (subscribeEvents) and mutates the
  // store reactively, so the dashboard just reads it. We seed once on mount
  // because push events are edge-triggered — a worktree idle since launch would
  // otherwise show nothing. The manual Refresh button re-seeds on demand.
  async function refreshAll(): Promise<void> {
    for (const worktree of store.worktrees) {
      await refreshRuntimes(worktree.id)
    }
  }

  onMount(() => {
    void refreshAll()
  })

  function services(worktreeId: string): ServiceRuntime[] {
    return store.services[worktreeId] || []
  }
  function agents(worktreeId: string): AgentRuntime[] {
    return store.agents[worktreeId] || []
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
      {@const attention = attentionFor(worktree.id)}
      <button
        class="rounded-lg border bg-surface p-3 text-left hover:border-line-strong {attention.needsAttention
          ? 'border-amber'
          : 'border-line'}"
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
          <span class="ml-auto flex items-center gap-1">
            {#if attention.waitingPermission}
              <span class="text-2xs text-amber" title="Waiting on permission">⊘ perm</span>
            {/if}
            {#if attention.waitingDialog}
              <span class="text-2xs text-amber" title="Waiting on a question">❓ ask</span>
            {/if}
            {#if attention.agentDone}
              <span class="text-2xs text-green" title="Agent finished">✓ done</span>
            {/if}
            {#if attention.serviceUnhealthy}
              <span class="text-2xs text-red" title="A service is unhealthy">● svc</span>
            {/if}
          </span>
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
              <span class="h-1.5 w-1.5 rounded-full {serviceStatusColor[service.status]}"></span>
              {service.name}
            </span>
          {/each}
          {#if services(worktree.id).length === 0}
            <span class="text-2xs text-dim">none</span>
          {/if}
        </div>

        <div class="mb-1 text-2xs uppercase tracking-caps text-dim">Agents</div>
        <div class="flex flex-wrap gap-1">
          {#each agents(worktree.id) as agent (agent.name)}
            <span class="flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-2xs">
              <span
                class="h-1.5 w-1.5 rounded-full {agentStatusColor[agent.status] ||
                  'bg-neutral-600'}"
              ></span>
              {agent.name}
            </span>
          {/each}
          {#if agents(worktree.id).length === 0}
            <span class="text-2xs text-dim">idle</span>
          {/if}
        </div>
      </button>
    {/each}
  </div>
</div>
