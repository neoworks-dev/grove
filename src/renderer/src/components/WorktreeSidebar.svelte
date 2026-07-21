<script lang="ts">
  import { store, selectWorktree, refreshWorktrees, focusAgentInPane } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { diffStatLabel } from '../lib/worktreeStatus'
  import CreateWorktreeDialog from './CreateWorktreeDialog.svelte'
  import MergeWorktreeDialog from './MergeWorktreeDialog.svelte'
  import WaveSpinner from './WaveSpinner.svelte'
  import AgentLogo from './AgentLogo.svelte'
  import type { Worktree, ServiceRuntime, AgentRuntime } from '../../../shared/types'

  let showDialog = $state(false)
  let mergeSource = $state<Worktree | null>(null)

  function agentsFor(worktreeId: string): AgentRuntime[] {
    return store.agents[worktreeId] || []
  }

  // Select the worktree, focus the Agent pane, and switch it to this instance.
  function openAgent(worktreeId: string, name: string, chatId: string, event: MouseEvent): void {
    event.stopPropagation()
    void focusAgentInPane(worktreeId, name, chatId)
    layout.ensurePane('agent')
  }

  // Open the worktree's shared chat in the right dock (like the agent pane).
  function openChat(worktree: Worktree): void {
    selectWorktree(worktree.id)
    layout.openDock('right', 'worktree-chat')
  }

  // Reveal the checkpoints timeline in the left sidebar for this worktree.
  function openCheckpoints(worktree: Worktree): void {
    selectWorktree(worktree.id)
    layout.showInDock('left', 'checkpoints')
  }

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
      {@const diff = diffStatLabel(worktree.id)}
      {@const agents = agentsFor(worktree.id)}
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
            {#if store.unread[worktree.id]}
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" title="Unread agent output"
              ></span>
            {/if}
          </div>
          <div class="truncate font-mono text-2xs text-dim">{worktree.branch}</div>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          {#if diff}
            <span class="font-mono text-2xs" title="Lines changed vs HEAD">
              <span class="text-green">+{diff.added}</span>
              <span class="text-red">−{diff.removed}</span>
            </span>
          {/if}
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
          <button
            class="hidden text-dim hover:text-default group-hover:block"
            title="Worktree chat"
            onclick={(event) => {
              event.stopPropagation()
              openChat(worktree)
            }}
          >
            ✉
          </button>
          <button
            class="hidden text-dim hover:text-default group-hover:block"
            title="Checkpoints"
            onclick={(event) => {
              event.stopPropagation()
              openCheckpoints(worktree)
            }}
          >
            ⟲
          </button>
          <button
            class="hidden text-dim hover:text-violet group-hover:block"
            title="Merge this worktree into another"
            onclick={(event) => {
              event.stopPropagation()
              mergeSource = worktree
            }}
          >
            ⤳
          </button>
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

      <!-- One row per spawned instance in this worktree, running or not. -->
      {#each agents as agent (agent.name + '::' + agent.chatId)}
        <button
          class="flex w-full items-center gap-2 py-1 pl-7 pr-3 text-left text-2xs hover:bg-hover {store.selectedWorktreeId ===
          worktree.id
            ? 'bg-surface'
            : ''}"
          title="{agent.name} · {agent.label} — {agent.status}"
          onclick={(event) => openAgent(worktree.id, agent.name, agent.chatId, event)}
        >
          <AgentLogo name={agent.name} size={14} active={agent.status === 'running'} />
          <span class="truncate {agent.status === 'running' ? 'text-default' : 'text-muted'}"
            >{agent.label}</span
          >
          {#if agent.status === 'running'}
            <span class="ml-auto text-green"><WaveSpinner count={3} /></span>
          {:else}
            <span class="ml-auto text-dim">{agent.status}</span>
          {/if}
        </button>
      {/each}
    {/each}

    {#if store.repo && store.worktrees.length === 0}
      <p class="px-3 py-4 text-xs text-dim">No worktrees.</p>
    {/if}
  </div>
</div>

{#if showDialog}
  <CreateWorktreeDialog onClose={() => (showDialog = false)} />
{/if}

{#if mergeSource}
  <MergeWorktreeDialog
    source={{ id: mergeSource.id, name: mergeSource.name, branch: mergeSource.branch }}
    onClose={() => (mergeSource = null)}
  />
{/if}
