<script lang="ts">
  // The list of pane types, as a floating menu. Shared by the pane controls'
  // "Change pane" (which swaps the pane in place) and the `+` on a gutter (which
  // opens a new window there), so both offer the same panes in the same order.
  import type { Snippet } from 'svelte'
  import { panes } from '../lib/panes.svelte'

  let {
    currentTypeId,
    onpick,
    footer
  }: {
    // Marked as the one already showing, when the menu is for an existing pane.
    currentTypeId?: string
    onpick: (paneTypeId: string) => void
    // Extra actions below the list (a separator is drawn above them).
    footer?: Snippet
  } = $props()

  // The empty-center placeholder is a fallback, never something to pick.
  const options = $derived(panes.types.filter((entry) => entry.id !== 'empty'))
</script>

<div class="max-h-64 w-40 overflow-auto rounded-md border border-line bg-elevated py-1 shadow-lg">
  {#each options as option (option.id)}
    <button
      class="block w-full px-2 py-1 text-left text-2xs hover:bg-hover"
      class:text-default={option.id === currentTypeId}
      class:text-dim={option.id !== currentTypeId}
      onclick={() => onpick(option.id)}
    >
      {option.title}
    </button>
  {/each}
  {#if footer}
    <div class="my-1 border-t border-line"></div>
    {@render footer()}
  {/if}
</div>
