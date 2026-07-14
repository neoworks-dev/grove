<script lang="ts">
  import WaveSpinner from '../WaveSpinner.svelte'
  import type { Subagent } from '../../lib/agent/subagents'

  let {
    subagents,
    isRunning,
    focusedKey,
    navActive,
    navIndex,
    onSelectMain,
    onSelect
  }: {
    subagents: Subagent[]
    isRunning: boolean
    focusedKey: string | null
    navActive: boolean
    navIndex: number
    onSelectMain: () => void
    onSelect: (key: string) => void
  } = $props()
</script>

<!-- Active agents: the main chat plus subagents spawned via the Task tool.
     ↓ to navigate, Enter to open one's transcript. -->
<div class="shrink-0 border-t border-line bg-elevated px-2 py-1.5">
  <div class="mb-1 px-1 text-2xs uppercase tracking-caps text-dim">
    Agents · <span class="normal-case tracking-normal">↓ navigate · enter open</span>
  </div>
  <div class="flex flex-col gap-0.5">
    <button
      class="flex items-center gap-2 rounded px-2 py-1 text-left text-2xs {navActive &&
      navIndex === 0
        ? 'bg-action text-action-fg'
        : 'text-muted hover:bg-hover'} {focusedKey === null ? 'ring-1 ring-green' : ''}"
      onclick={onSelectMain}
    >
      {#if isRunning}
        <span class="shrink-0 text-green"><WaveSpinner /></span>
      {:else}
        <span class="shrink-0 text-dim">✓</span>
      {/if}
      <span class="shrink-0 font-mono font-semibold text-green">main</span>
    </button>
    {#each subagents as agent, index (agent.key)}
      <button
        class="flex items-center gap-2 rounded px-2 py-1 text-left text-2xs {navActive &&
        index + 1 === navIndex
          ? 'bg-action text-action-fg'
          : 'text-muted hover:bg-hover'} {agent.key === focusedKey ? 'ring-1 ring-green' : ''}"
        onclick={() => onSelect(agent.key)}
      >
        {#if agent.running}
          <span class="shrink-0 text-green"><WaveSpinner /></span>
        {:else}
          <span class="shrink-0 text-dim">✓</span>
        {/if}
        <span class="shrink-0 font-mono font-semibold text-violet">{agent.type}</span>
        {#if agent.description}
          <span class="truncate text-muted">{agent.description}</span>
        {/if}
      </button>
    {/each}
  </div>
</div>
