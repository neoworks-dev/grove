<script lang="ts">
  // A labelled button that drops a panel under it. Both bars in the pane are
  // built from these, so the filter menus and the bulk-action menus behave the
  // same way: click to open, click anywhere else or press Escape to close.
  //
  // Deliberately not the app's ContextMenu — that one is summoned at a pointer
  // position for a right-click. This is anchored to its own trigger.
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon'
  import type { Snippet } from 'svelte'

  let {
    label,
    icon,
    count = 0,
    disabled = false,
    align = 'left',
    children
  }: {
    label: string
    icon?: Snippet
    /** Shown beside the label when the menu has an active selection. */
    count?: number
    disabled?: boolean
    align?: 'left' | 'right'
    children: Snippet<[() => void]>
  } = $props()

  let open = $state(false)
  let root = $state<HTMLElement | null>(null)

  function close(): void {
    open = false
  }

  // Pointerdown rather than click: a click that lands on another trigger should
  // close this one before that one opens, not after.
  $effect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (root && root.contains(event.target as Node)) return
      close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  })
</script>

<div class="relative" bind:this={root}>
  <button
    class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs hover:bg-hover disabled:opacity-50"
    class:text-default={count > 0 || open}
    class:text-dim={count === 0 && !open}
    {disabled}
    aria-expanded={open}
    aria-haspopup="menu"
    onclick={() => (open = !open)}
  >
    {#if icon}
      {@render icon()}
    {/if}
    {label}
    {#if count > 0}
      <span class="rounded-full bg-action px-1 text-[9px] text-action-fg">{count}</span>
    {/if}
    <CaretDownIcon size={9} />
  </button>

  {#if open}
    <div
      class="absolute top-full z-20 mt-1 w-56 rounded-md border border-line-strong bg-elevated p-1.5 shadow-lg"
      class:left-0={align === 'left'}
      class:right-0={align === 'right'}
      role="menu"
      tabindex="-1"
    >
      {@render children(close)}
    </div>
  {/if}
</div>
