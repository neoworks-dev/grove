<script lang="ts">
  // Launcher rail — one of the canonical control surfaces. Icons come from
  // pane types registered with `rail` metadata (clicking surfaces the pane in
  // the split tree) plus plugin-contributed action launchers.
  import Icon from '@iconify/svelte'
  import { panes } from '../lib/panes.svelte'
  import { layout } from '../lib/layout.svelte'
  import { sidebar } from '../lib/sidebar.svelte'
</script>

<div class="flex w-11 shrink-0 flex-col items-center gap-1 py-2">
  {#each panes.railTypes() as type (type.id)}
    {@const RailIcon = type.icon}
    <button
      class="flex h-9 w-9 items-center justify-center rounded-md {layout.docks.left.open &&
      layout.docks.left.paneType === type.id
        ? 'bg-raised text-default'
        : 'text-dim hover:bg-hover hover:text-default'}"
      title={type.title}
      aria-label={type.title}
      onclick={() => layout.showInDock('left', type.id)}
    >
      {#if RailIcon}<RailIcon size={20} />{/if}
    </button>
  {/each}
  {#each sidebar.launchers as launcher (launcher.id)}
    <button
      class="flex h-9 w-9 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-default"
      title={launcher.label}
      aria-label={launcher.label}
      onclick={() => void launcher.run()}
    >
      <Icon icon={launcher.icon} width="20" height="20" />
    </button>
  {/each}
</div>
