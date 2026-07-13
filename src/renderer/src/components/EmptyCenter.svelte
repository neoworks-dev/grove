<script lang="ts">
  // Placeholder shown when the center split has no real pane open (e.g. the last
  // editor was closed). Keeps the center present instead of collapsing the docks
  // into it, and offers quick ways to fill it again.
  import { layout } from '../lib/layout.svelte'
  import { store } from '../lib/store.svelte'

  let { leafId }: { leafId: string } = $props()

  const actions = [
    { label: 'Editor', type: 'nvim' },
    { label: 'Diff', type: 'diff' },
    { label: 'Terminal', type: 'terminal' },
    { label: 'Dashboard', type: 'dashboard' }
  ]

  // The empty pane occupies the sole center leaf; replace that leaf in place.
  function open(type: string): void {
    layout.setLeafType(leafId, type)
  }
</script>

<div class="flex h-full flex-col items-center justify-center gap-4 text-dim">
  <div class="text-sm">Nothing open here</div>
  <div class="flex flex-wrap justify-center gap-2">
    {#each actions as action (action.type)}
      <button
        class="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-hover hover:text-default"
        onclick={() => open(action.type)}
        disabled={!store.repo}
      >
        {action.label}
      </button>
    {/each}
  </div>
  {#if !store.repo}
    <div class="text-2xs">Open a repository to begin.</div>
  {/if}
</div>
