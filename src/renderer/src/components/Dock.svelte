<script lang="ts">
  // A docked side panel: fixed to the left or right edge, outside the moveable
  // split tree so it never drifts or collapses. Hosts a single pane type
  // (rail-driven on the left, user-pickable on the right), is focus/keyboard
  // navigable via use:pane, and resizes with an edge handle. It deliberately
  // sets NO data-leaf attribute, so pane drag-and-drop ignores it.
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon'
  import MissingPane from './MissingPane.svelte'
  import { panes } from '../lib/panes.svelte'
  import { keymap, pane } from '../lib/keymap.svelte'
  import { layout, dockLeafId } from '../lib/layout.svelte'
  import type { DockSide } from '../../../shared/types'

  let { side }: { side: DockSide } = $props()

  const dock = $derived(layout.docks[side])
  const type = $derived(panes.get(dock.paneType))
  const leafId = $derived(dockLeafId(side))
  // Nested panes (the file tree, etc.) report their own pane id, so surface
  // containment — not pane-id equality — decides whether this dock is active.
  const active = $derived(keymap.activeSurfaceId === leafId)

  // Per-pane font zoom. Canvas panes (e.g. a terminal picked into the right
  // dock) scale their own font; DOM panes get CSS zoom on the content area,
  // leaving the dock header at native size.
  const fontScale = $derived(layout.fontScale(leafId))
  const zoomStyle = $derived(
    !type?.ownsFontScale && fontScale !== 1 ? `zoom: ${fontScale}` : ''
  )

  let pickerOpen = $state(false)
  let menuEl = $state<HTMLDivElement>()

  /** Close the pane menu when a pointer press lands outside it. */
  function onWindowPointerDown(event: PointerEvent): void {
    if (!pickerOpen) return
    if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return
    pickerOpen = false
  }

  // Right dock is a utility slot: the user can swap the agent panel for a
  // terminal or anything else. Left dock content is chosen from the rail.
  const pickable = $derived(side === 'right')
  const options = $derived(panes.types.filter((entry) => entry.id !== 'empty'))

  function choose(paneType: string): void {
    pickerOpen = false
    layout.openDock(side, paneType)
  }

  function collapse(): void {
    layout.setDockOpen(side, false)
  }

  // Dock content manages its own persistence (keyed by the stable dock leaf id),
  // so leaf state is a no-op here.
  function updateState(): void {}
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  class="relative flex h-full shrink-0 flex-col {side === 'left'
    ? 'border-l border-line-faint'
    : ''}"
  style="width:{dock.size}px"
>
  <div
    use:pane={{ id: leafId, type: type?.contextType ?? dock.paneType, modes: type?.modes }}
    data-pane={leafId}
    data-surface={leafId}
    data-zoom-container={leafId}
    class="pane-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none {type?.containerClass ??
      ''} {active ? 'pane-active' : ''}"
  >
    <!-- Floating pane menu instead of a header: a "…" button in the top-right
         corner that only fades in when the pointer is near it. The menu holds
         the pane-type picker (right dock) and the collapse action. -->
    <div
      bind:this={menuEl}
      class="group/dockmenu absolute right-0 top-0 z-30 flex flex-col items-end p-1.5"
    >
      <button
        class="flex h-6 w-6 items-center justify-center rounded-md text-dim opacity-0 transition-opacity duration-100 hover:bg-hover hover:text-default group-hover/dockmenu:opacity-100 {pickerOpen
          ? 'opacity-100'
          : ''}"
        title="Pane options"
        onclick={() => (pickerOpen = !pickerOpen)}
      >
        <DotsThreeIcon size={14} weight="bold" />
      </button>
      {#if pickerOpen}
        <div
          class="mt-1 max-h-64 w-40 overflow-auto rounded-md border border-line bg-elevated py-1 shadow-lg"
        >
          {#if pickable}
            {#each options as option (option.id)}
              <button
                class="block w-full px-2 py-1 text-left text-2xs hover:bg-hover {option.id ===
                dock.paneType
                  ? 'text-default'
                  : 'text-dim'}"
                onclick={() => choose(option.id)}
              >
                {option.title}
              </button>
            {/each}
            <div class="my-1 border-t border-line"></div>
          {/if}
          <button
            class="block w-full px-2 py-1 text-left text-2xs text-dim hover:bg-hover hover:text-default"
            onclick={() => {
              pickerOpen = false
              collapse()
            }}
          >
            Collapse panel
          </button>
        </div>
      {/if}
    </div>

    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={zoomStyle}>
      {#if !type}
        <MissingPane paneTypeId={dock.paneType} />
      {:else}
        {#key dock.paneType}
          {@const Content = type.component}
          <Content {leafId} paneTypeId={dock.paneType} state={{}} {updateState} />
        {/key}
      {/if}
    </div>
  </div>
</div>
