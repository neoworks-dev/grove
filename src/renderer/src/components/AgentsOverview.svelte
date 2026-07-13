<script lang="ts">
  // Cross-worktree agent cockpit. Lists every worktree's agent with live status,
  // last output line, and attention badges — all read from push-fed store state
  // (no polling). Clicking a row selects that worktree and focuses the full
  // Agent pane. The backend already streams every worktree concurrently; this is
  // the surface that makes the parallelism visible.
  import { store, selectWorktree } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { attentionFor, lastAgentLine, agentStatusColor } from '../lib/worktreeStatus'
  import type { AgentRuntime } from '../../../shared/types'

  function agentsFor(worktreeId: string): AgentRuntime[] {
    return store.agents[worktreeId] || []
  }

  function runningAgent(worktreeId: string): AgentRuntime | null {
    const agents = agentsFor(worktreeId)
    return agents.find((agent) => agent.status === 'running') || agents[0] || null
  }

  // Select the worktree and open/focus the full Agent pane.
  function focusAgent(worktreeId: string): void {
    selectWorktree(worktreeId)
    layout.ensurePane('agent')
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center justify-between px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Agents</span>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#each store.worktrees as worktree (worktree.id)}
      {@const agent = runningAgent(worktree.id)}
      {@const attention = attentionFor(worktree.id)}
      {@const line = lastAgentLine(worktree.id)}
      <button
        class="flex w-full flex-col gap-1 border-b border-line px-3 py-2 text-left hover:bg-hover {store.selectedWorktreeId ===
        worktree.id
          ? 'bg-surface'
          : ''}"
        onclick={() => focusAgent(worktree.id)}
      >
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 shrink-0 rounded-full {agent
            ? agentStatusColor[agent.status] || 'bg-neutral-600'
            : 'bg-neutral-700'}"></span>
          <span class="truncate text-xs font-medium">{worktree.name}</span>
          {#if attention.waitingPermission}
            <span class="ml-auto text-2xs text-amber" title="Waiting on permission">⊘ perm</span>
          {:else if attention.waitingDialog}
            <span class="ml-auto text-2xs text-amber" title="Waiting on a question">❓ ask</span>
          {:else if attention.agentDone}
            <span class="ml-auto text-2xs text-green" title="Agent finished">✓ done</span>
          {:else if attention.serviceUnhealthy}
            <span class="ml-auto text-2xs text-red" title="A service is unhealthy">● svc</span>
          {/if}
        </div>
        <div class="truncate font-mono text-2xs text-dim">
          {worktree.branch}
        </div>
        {#if agent}
          <div class="truncate text-2xs text-dim">
            <span class="text-default">{agent.name}</span>
            {#if line}<span class="ml-1">{line}</span>{/if}
          </div>
        {:else}
          <div class="text-2xs text-dim">idle</div>
        {/if}
      </button>
    {/each}
    {#if store.worktrees.length === 0}
      <p class="px-3 py-4 text-xs text-dim">No worktrees.</p>
    {/if}
  </div>
</div>
