<script lang="ts">
  // The canonical window: a leaf of the split tree. Registers itself as a
  // focusable pane and renders whatever pane type it references.
  import MissingPane from './MissingPane.svelte'
  import { panes } from '../lib/panes.svelte'
  import { keymap, pane } from '../lib/keymap.svelte'
  import { layout } from '../lib/layout.svelte'
  import { paneDrag } from '../lib/paneDrag.svelte'
  import type { LeafNode } from '../lib/layoutTree'

  let { leaf }: { leaf: LeafNode } = $props()

  const type = $derived(panes.get(leaf.paneTypeId))
  const available = $derived(type !== null && (!type.when || type.when()))
  const dragged = $derived(paneDrag.draggedLeafId === leaf.id)

  // Per-pane font zoom. Canvas panes (nvim, terminal) scale their own font, so
  // only DOM panes get the generic CSS zoom on the container.
  const fontScale = $derived(layout.fontScale(leaf.id))
  const zoomStyle = $derived(
    !type?.ownsFontScale && fontScale !== 1 ? `zoom: ${fontScale}` : ''
  )

  function updateState(patch: Record<string, unknown>): void {
    layout.updateLeafState(leaf.id, patch)
  }

  // Alt+drag relocates the pane; the leaf-level handler claims the gesture
  // before pane content sees it (panes suppress their own Alt-mousedown).
  function onPointerDown(event: PointerEvent): void {
    if (!event.altKey || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    paneDrag.start(leaf.id, event)
  }
</script>

<div
  use:pane={{ id: leaf.id, type: type?.contextType ?? leaf.paneTypeId, modes: type?.modes }}
  data-leaf={leaf.id}
  data-zoom-container={leaf.id}
  style={zoomStyle}
  onpointerdown={onPointerDown}
  class="flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden outline-none {type?.containerClass ??
    ''} {keymap.activePane === leaf.id ? 'pane-active' : ''} {dragged ? 'opacity-40' : ''}"
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
      <Content
        leafId={leaf.id}
        paneTypeId={leaf.paneTypeId}
        state={leaf.paneState ?? {}}
        {updateState}
      />
    {/key}
  {/if}
</div>
