<script lang="ts">
  // Launcher rail — one of the canonical control surfaces. Icons come from
  // pane types registered with `rail` metadata (base app and plugins alike);
  // clicking one surfaces that pane in the split tree.
  import { panes } from '../lib/panes.svelte'
  import { layout } from '../lib/layout.svelte'
</script>

<div class="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-elevated py-2">
  {#each panes.railTypes() as type (type.id)}
    {@const Icon = type.icon}
    <button
      class="flex h-9 w-9 items-center justify-center rounded-md {layout.hasPane(type.id)
        ? 'bg-surface text-default'
        : 'text-dim hover:bg-hover hover:text-default'}"
      title={type.title}
      aria-label={type.title}
      onclick={() => layout.ensurePane(type.id)}
    >
      {#if Icon}<Icon size={20} />{/if}
    </button>
  {/each}
</div>
