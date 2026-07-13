<script lang="ts">
  // A docked side panel: fixed to the left or right edge, outside the moveable
  // split tree so it never drifts or collapses. Hosts a single pane type
  // (rail-driven on the left, user-pickable on the right), is focus/keyboard
  // navigable via use:pane, and resizes with an edge handle. It deliberately
  // sets NO data-leaf attribute, so pane drag-and-drop ignores it.
  import MissingPane from './MissingPane.svelte'
  import { panes } from '../lib/panes.svelte'
  import { keymap, pane } from '../lib/keymap.svelte'
  import { layout, dockLeafId } from '../lib/layout.svelte'
  import type { DockSide } from '../../../shared/types'

  let { side }: { side: DockSide } = $props()

  const dock = $derived(layout.docks[side])
  const type = $derived(panes.get(dock.paneType))
  const leafId = $derived(dockLeafId(side))
  const active = $derived(keymap.activePane === leafId)

  let pickerOpen = $state(false)

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

  // Drag the inner edge to resize. Left dock grows rightward, right dock leftward.
  function startResize(event: PointerEvent): void {
    event.preventDefault()
    const startX = event.clientX
    const startSize = dock.size
    const onMove = (move: PointerEvent): void => {
      const delta = move.clientX - startX
      const next = side === 'left' ? startSize + delta : startSize - delta
      layout.resizeDock(side, next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
</script>

<div
  class="relative flex h-full shrink-0 flex-col bg-elevated {side === 'left'
    ? 'border-r'
    : 'border-l'} border-line"
  style="width:{dock.size}px"
>
  <div
    use:pane={{ id: leafId, type: type?.contextType ?? dock.paneType, modes: type?.modes }}
    data-pane={leafId}
    class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none {type?.containerClass ??
      ''} {active ? 'pane-active' : ''}"
  >
    <!-- Dock header: title, optional type picker (right), collapse. -->
    <div class="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2">
      {#if pickable}
        <div class="relative">
          <button
            class="flex items-center gap-1 rounded px-1 text-2xs font-semibold uppercase tracking-caps text-dim hover:text-default"
            onclick={() => (pickerOpen = !pickerOpen)}
          >
            {type?.title ?? dock.paneType} ▾
          </button>
          {#if pickerOpen}
            <div
              class="absolute left-0 top-full z-20 mt-1 max-h-64 w-40 overflow-auto rounded border border-line bg-raised py-1 shadow-lg"
            >
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
            </div>
          {/if}
        </div>
      {:else}
        <span class="text-2xs font-semibold uppercase tracking-caps text-dim"
          >{type?.title ?? dock.paneType}</span
        >
      {/if}
      <button
        class="ml-auto text-dim hover:text-default"
        title="Collapse panel"
        onclick={collapse}
      >
        {side === 'left' ? '«' : '»'}
      </button>
    </div>

    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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

  <!-- Resize handle on the inner edge. -->
  <div
    class="absolute top-0 z-10 h-full w-1 cursor-col-resize hover:bg-action/40 {side === 'left'
      ? 'right-0'
      : 'left-0'}"
    onpointerdown={startResize}
    role="separator"
    aria-orientation="vertical"
  ></div>
</div>
