<script lang="ts">
  // The canonical window: a leaf of the split tree. Registers itself as a
  // focusable pane and renders whatever pane type it references.
  import MissingPane from './MissingPane.svelte'
  import { panes } from '../lib/panes.svelte'
  import { keymap, pane } from '../lib/keymap.svelte'
  import { layout } from '../lib/layout.svelte'
  import type { LeafNode } from '../lib/layoutTree'

  let { leaf }: { leaf: LeafNode } = $props()

  const type = $derived(panes.get(leaf.paneTypeId))
  const available = $derived(type !== null && (!type.when || type.when()))

  function updateState(patch: Record<string, unknown>): void {
    layout.updateLeafState(leaf.id, patch)
  }
</script>

<div
  use:pane={{ id: leaf.id, type: leaf.paneTypeId }}
  data-leaf={leaf.id}
  class="flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden outline-none {type?.containerClass ??
    ''} {keymap.activePane === leaf.id ? 'pane-active' : ''}"
>
  {#if !type}
    <MissingPane paneTypeId={leaf.paneTypeId} />
  {:else if !available}
    <div class="flex flex-1 items-center justify-center text-dim">
      Open a Git repository to begin.
    </div>
  {:else}
    {#key leaf.paneTypeId}
      {@const Content = type.component}
      <Content leafId={leaf.id} state={leaf.paneState ?? {}} {updateState} />
    {/key}
  {/if}
</div>
