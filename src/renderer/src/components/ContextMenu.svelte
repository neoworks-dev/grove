<script lang="ts" module>
  // Reusable context menu: a fixed-position list at the cursor that closes on
  // outside-click or Escape. Items run an action; a divider is `{ divider: true }`.
  export interface MenuItem {
    label?: string
    action?: () => void
    divider?: boolean
    danger?: boolean
  }
</script>

<script lang="ts">
  let {
    x,
    y,
    items,
    onClose
  }: {
    x: number
    y: number
    items: MenuItem[]
    onClose: () => void
  } = $props()

  function choose(item: MenuItem): void {
    if (item.divider || !item.action) return
    onClose()
    item.action()
  }

  // Clamp so the menu stays on screen.
  const left = $derived(Math.min(x, window.innerWidth - 200))
  const top = $derived(Math.min(y, window.innerHeight - items.length * 28 - 12))
</script>

<svelte:window
  onkeydown={(event) => event.key === 'Escape' && onClose()}
  onmousedown={onClose}
/>

<div
  class="fixed z-modal min-w-[168px] overflow-hidden rounded-md border border-line bg-elevated py-1 shadow-overlay"
  style="left:{left}px; top:{top}px"
  role="menu"
  tabindex="-1"
  onmousedown={(event) => event.stopPropagation()}
>
  {#each items as item, index (index)}
    {#if item.divider}
      <div class="my-1 border-t border-line"></div>
    {:else}
      <button
        class="flex w-full items-center px-3 py-1 text-left text-xs hover:bg-hover {item.danger
          ? 'text-red'
          : 'text-muted'}"
        role="menuitem"
        onclick={() => choose(item)}
      >
        {item.label}
      </button>
    {/if}
  {/each}
</div>
