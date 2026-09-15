<script lang="ts">
  // The per-pane control corner: a "…" button that fades in on hover and opens
  // the pane-type picker plus the close action. Every window carries it, so any
  // pane can become any other pane without going through the rail.
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon'
  import { panes } from '../lib/panes.svelte'
  import { layout } from '../lib/layout.svelte'

  let { leafId, paneTypeId }: { leafId: string; paneTypeId: string } = $props()

  let open = $state(false)
  let menuEl = $state<HTMLDivElement>()

  // The empty-center placeholder is a fallback, never something to pick.
  const options = $derived(panes.types.filter((entry) => entry.id !== 'empty'))

  /** Close the menu when a pointer press lands outside it. */
  function onWindowPointerDown(event: PointerEvent): void {
    if (!open) return
    if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return
    open = false
  }

  function choose(nextTypeId: string): void {
    open = false
    if (nextTypeId === paneTypeId) return
    layout.setLeafType(leafId, nextTypeId)
  }

  function close(): void {
    open = false
    layout.closeLeaf(leafId)
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  bind:this={menuEl}
  class="group/panemenu absolute right-0 top-0 z-30 flex flex-col items-end p-1.5"
>
  <button
    class="flex h-6 w-6 items-center justify-center rounded-md text-dim opacity-0 transition-opacity duration-100 hover:bg-hover hover:text-default group-hover/panemenu:opacity-100"
    class:opacity-100={open}
    title="Pane options"
    onclick={() => (open = !open)}
  >
    <DotsThreeIcon size={14} weight="bold" />
  </button>
  {#if open}
    <div
      class="mt-1 max-h-64 w-40 overflow-auto rounded-md border border-line bg-elevated py-1 shadow-lg"
    >
      {#each options as option (option.id)}
        <button
          class="block w-full px-2 py-1 text-left text-2xs hover:bg-hover"
          class:text-default={option.id === paneTypeId}
          class:text-dim={option.id !== paneTypeId}
          onclick={() => choose(option.id)}
        >
          {option.title}
        </button>
      {/each}
      <div class="my-1 border-t border-line"></div>
      <button
        class="block w-full px-2 py-1 text-left text-2xs text-dim hover:bg-hover hover:text-default"
        onclick={close}
      >
        Close pane
      </button>
    </div>
  {/if}
</div>
