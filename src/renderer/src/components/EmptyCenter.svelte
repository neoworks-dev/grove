<script lang="ts">
  // Placeholder shown when no editor window is open (e.g. the last one was
  // closed). Keeps the editor's place in the tree rather than letting the other
  // panes swallow it, and offers quick ways to fill it again.
  import { layout } from '../lib/layout.svelte'
  import { panes } from '../lib/panes.svelte'
  import { store } from '../lib/store.svelte'
  import { CENTER_SLOT } from '../lib/paneSlots'

  let { leafId }: { leafId: string } = $props()

  // Read off the registry rather than listed here: this leaf holds a center
  // pane, so what may fill it is whichever center panes are registered — and a
  // hardcoded list went stale the moment one of them was renamed or removed.
  const actions = $derived(
    panes.openableTypes().filter((type) => type.slot === CENTER_SLOT && type.id !== 'empty')
  )

  // The empty pane occupies the sole center leaf; replace that leaf in place.
  function open(type: string): void {
    layout.setLeafType(leafId, type)
  }
</script>

<div class="flex h-full flex-col items-center justify-center gap-4 text-dim">
  <div class="text-sm">Nothing open here</div>
  <div class="flex flex-wrap justify-center gap-2">
    {#each actions as action (action.id)}
      <button
        class="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-hover hover:text-default"
        onclick={() => open(action.id)}
        disabled={!store.repo}
      >
        {action.title}
      </button>
    {/each}
  </div>
  {#if !store.repo}
    <div class="text-2xs">Open a folder to begin.</div>
  {/if}
</div>
