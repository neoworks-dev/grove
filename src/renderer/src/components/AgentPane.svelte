<script lang="ts">
  import { store, refreshRuntimes } from '../lib/store.svelte'
  import type { LogLine } from '../lib/store.svelte'
  import type { AgentRuntime } from '../../../shared/types'

  let prompt = $state('')

  const statusColor: Record<string, string> = {
    running: 'text-green',
    exited: 'text-dim',
    error: 'text-red',
    stopped: 'text-dim'
  }

  const agents = $derived<AgentRuntime[]>(
    store.selectedWorktreeId ? store.agents[store.selectedWorktreeId] || [] : []
  )

  // Agent output lines for the selected worktree.
  const agentLines = $derived<LogLine[]>(
    (store.selectedWorktreeId ? store.logs[store.selectedWorktreeId] || [] : []).filter(
      (line) => line.source === 'agent'
    )
  )

  async function launch(name: string): Promise<void> {
    if (!store.selectedWorktreeId) return
    try {
      await window.workbench.agents.start(store.selectedWorktreeId, name, prompt.trim() || undefined)
      await refreshRuntimes(store.selectedWorktreeId)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  async function stop(name: string): Promise<void> {
    if (!store.selectedWorktreeId) return
    await window.workbench.agents.stop(store.selectedWorktreeId, name)
    await refreshRuntimes(store.selectedWorktreeId)
  }

  // Pretty-print a line if it is valid JSON (e.g. claude -p output).
  function formatLine(line: string): string {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return line
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return line
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="border-b border-line px-3 py-2 text-2xs font-semibold uppercase tracking-caps text-dim">
    Agents
    {#if store.selectedWorktree}
      <span class="ml-1 normal-case text-muted">· {store.selectedWorktree.name}</span>
    {/if}
  </div>

  {#if !store.selectedWorktreeId}
    <p class="px-3 py-3 text-xs text-dim">Select a worktree.</p>
  {:else}
    <div class="shrink-0 border-b border-line px-3 py-2">
      <textarea
        class="mb-2 h-16 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
        placeholder="Optional prompt passed as an argument…"
        bind:value={prompt}
      ></textarea>
      <div class="flex flex-wrap gap-1">
        {#each agents as agent (agent.name)}
          <div class="flex items-center gap-1">
            {#if agent.status === 'running'}
              <button
                class="rounded border border-line px-2 py-1 text-2xs hover:bg-hover"
                onclick={() => stop(agent.name)}
              >
                ■ {agent.name}
              </button>
            {:else}
              <button
                class="rounded bg-action px-2 py-1 text-2xs text-action-fg"
                onclick={() => launch(agent.name)}
              >
                ▶ {agent.name}
              </button>
            {/if}
          </div>
        {/each}
        {#if agents.length === 0}
          <span class="text-2xs text-dim">No agents configured.</span>
        {/if}
      </div>
    </div>

    <!-- Status list -->
    <div class="shrink-0 border-b border-line px-3 py-2">
      {#each agents as agent (agent.name)}
        <div class="flex items-center gap-2 py-0.5 text-2xs">
          <span class="{statusColor[agent.status]}">●</span>
          <span class="w-20 truncate">{agent.name}</span>
          <span class="text-dim">{agent.status}</span>
          {#if agent.exitCode !== null}
            <span class="text-dim">exit {agent.exitCode}</span>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Captured output -->
    <div class="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-2xs leading-relaxed">
      {#each agentLines as entry, index (index)}
        <pre class="whitespace-pre-wrap text-muted"><span class="text-dim">[{entry.name}]</span> {formatLine(
            entry.line
          )}</pre>
      {/each}
      {#if agentLines.length === 0}
        <p class="text-dim">No agent output yet.</p>
      {/if}
    </div>
  {/if}
</div>
