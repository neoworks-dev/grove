<script lang="ts">
  import { store } from '../lib/store.svelte'
  import ServicesPanel from './ServicesPanel.svelte'
  import type { LogLine } from '../lib/store.svelte'

  let tab = $state<'logs' | 'services'>('logs')
  let sourceFilter = $state<string>('all')
  let logContainer = $state<HTMLDivElement>()

  const lines = $derived<LogLine[]>(
    store.selectedWorktreeId ? store.logs[store.selectedWorktreeId] || [] : []
  )

  const sources = $derived(
    Array.from(new Set(lines.map((line) => `${line.source}:${line.name}`)))
  )

  const filtered = $derived(
    sourceFilter === 'all'
      ? lines
      : lines.filter((line) => `${line.source}:${line.name}` === sourceFilter)
  )

  const lineColor: Record<string, string> = { service: 'text-muted', agent: 'text-violet' }

  // Autoscroll to bottom on new lines.
  $effect(() => {
    filtered.length
    if (logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight
    }
  })

  function clearLogs(): void {
    if (store.selectedWorktreeId) {
      store.logs = { ...store.logs, [store.selectedWorktreeId]: [] }
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
    <button
      class="rounded px-2 py-0.5 text-xs {tab === 'logs'
        ? 'bg-surface text-default'
        : 'text-dim hover:text-default'}"
      onclick={() => (tab = 'logs')}>Logs</button
    >
    <button
      class="rounded px-2 py-0.5 text-xs {tab === 'services'
        ? 'bg-surface text-default'
        : 'text-dim hover:text-default'}"
      onclick={() => (tab = 'services')}>Services</button
    >

    {#if tab === 'logs'}
      <select
        class="ml-2 rounded border border-line bg-input px-1.5 py-0.5 text-2xs"
        bind:value={sourceFilter}
      >
        <option value="all">all sources</option>
        {#each sources as source (source)}
          <option value={source}>{source}</option>
        {/each}
      </select>
      <button class="ml-auto text-2xs text-dim hover:text-default" onclick={clearLogs}>clear</button>
    {/if}
  </div>

  {#if tab === 'logs'}
    <div
      bind:this={logContainer}
      class="min-h-0 flex-1 overflow-auto px-3 py-1.5 font-mono text-2xs leading-relaxed"
    >
      {#each filtered as entry, index (index)}
        <div class="whitespace-pre-wrap {lineColor[entry.source]}">
          <span class="text-dim">[{entry.name}]</span>
          {entry.line}
        </div>
      {/each}
      {#if filtered.length === 0}
        <p class="text-dim">No output yet.</p>
      {/if}
    </div>
  {:else}
    <div class="min-h-0 flex-1">
      <ServicesPanel />
    </div>
  {/if}
</div>
