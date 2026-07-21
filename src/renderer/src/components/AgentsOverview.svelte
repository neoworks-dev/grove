<script lang="ts">
  // Cross-worktree agent cockpit. Groups every worktree's agents so the running
  // ones are easy to spot: each agent row shows a live status dot, a working
  // spinner, an attention badge (unread / waiting), and its last output line.
  // All state is read from push-fed store data (no polling). Clicking a worktree
  // header selects it and focuses the Agent pane; clicking an agent also selects
  // that agent inside the pane.
  import { store, selectWorktree, focusAgentInPane } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import {
    attentionFor,
    lastAgentLineFor,
    agentStatusColor,
    diffStatLabel
  } from '../lib/worktreeStatus'
  import WaveSpinner from './WaveSpinner.svelte'
  import type { AgentRuntime } from '../../../shared/types'

  function agentsFor(worktreeId: string): AgentRuntime[] {
    return store.agents[worktreeId] || []
  }

  function isWorking(agent: AgentRuntime): boolean {
    return agent.status === 'running'
  }

  function waitingPermission(worktreeId: string, name: string): boolean {
    return store.pendingPermissions.some(
      (request) => request.worktreeId === worktreeId && request.agent === name
    )
  }

  function waitingDialog(worktreeId: string, name: string): boolean {
    return store.pendingDialogs.some(
      (request) => request.worktreeId === worktreeId && request.agent === name
    )
  }

  // Select the worktree and open/focus the full Agent pane.
  function focusWorktree(worktreeId: string): void {
    selectWorktree(worktreeId)
    layout.ensurePane('agent')
  }

  // Select the worktree, focus the pane, and switch it to this instance.
  function openAgent(worktreeId: string, name: string, chatId: string): void {
    void focusAgentInPane(worktreeId, name, chatId)
    layout.ensurePane('agent')
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center justify-between px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Agents</span>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#each store.worktrees as worktree (worktree.id)}
      {@const agents = agentsFor(worktree.id)}
      {@const attention = attentionFor(worktree.id)}
      {@const diff = diffStatLabel(worktree.id)}
      <div class="border-b border-line">
        <!-- Worktree header -->
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover {store.selectedWorktreeId ===
          worktree.id
            ? 'bg-surface'
            : ''}"
          onclick={() => focusWorktree(worktree.id)}
        >
          <span class="truncate text-xs font-semibold">{worktree.name}</span>
          <span class="truncate font-mono text-2xs text-dim">{worktree.branch}</span>
          {#if diff}
            <span class="ml-auto shrink-0 font-mono text-2xs" title="Lines changed vs HEAD">
              <span class="text-green">+{diff.added}</span>
              <span class="text-red">−{diff.removed}</span>
            </span>
          {/if}
        </button>

        <!-- Agent rows -->
        {#if agents.length === 0}
          <div class="px-3 pb-1.5 pl-5 text-2xs text-dim">idle — no agents</div>
        {:else}
          {#each agents as agent (agent.name + '::' + agent.chatId)}
            {@const working = isWorking(agent)}
            {@const perm = waitingPermission(worktree.id, agent.name)}
            {@const ask = waitingDialog(worktree.id, agent.name)}
            {@const line = lastAgentLineFor(worktree.id, agent.name, agent.chatId)}
            <button
              class="flex w-full flex-col gap-0.5 py-1 pl-5 pr-3 text-left hover:bg-hover"
              onclick={() => openAgent(worktree.id, agent.name, agent.chatId)}
            >
              <div class="flex items-center gap-2">
                <span
                  class="h-2 w-2 shrink-0 rounded-full {agentStatusColor[agent.status] ||
                    'bg-neutral-700'}"
                ></span>
                <span class="truncate text-xs font-medium text-default">{agent.name}</span>
                <span class="truncate text-2xs text-muted">{agent.label}</span>
                {#if working}
                  <span class="text-green"><WaveSpinner count={3} /></span>
                {/if}
                {#if perm}
                  <span class="ml-auto shrink-0 text-2xs text-amber" title="Waiting on permission"
                    >⊘ perm</span
                  >
                {:else if ask}
                  <span class="ml-auto shrink-0 text-2xs text-amber" title="Waiting on a question"
                    >❓ ask</span
                  >
                {:else if attention.unread}
                  <span class="ml-auto shrink-0 text-2xs text-amber" title="Unread agent output"
                    >✉ unread</span
                  >
                {:else if agent.status === 'exited' || agent.status === 'error'}
                  <span class="ml-auto shrink-0 text-2xs text-green" title="Agent finished"
                    >✓ done</span
                  >
                {/if}
              </div>
              {#if line}
                <div class="truncate pl-4 text-2xs text-dim">{line}</div>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/each}
    {#if store.worktrees.length === 0}
      <p class="px-3 py-4 text-xs text-dim">No worktrees.</p>
    {/if}
  </div>
</div>
