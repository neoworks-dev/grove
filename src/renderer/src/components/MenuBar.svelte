<script lang="ts">
  // Header app menu (File, View, …). Renders the menu registry; items are
  // grouped with separators and delegate to commands where possible.
  import { menu, type MenuItem } from '../lib/menu.svelte'
  import { keyDispatch, KeyPriority } from '../lib/keyDispatch'
  import { fade, scale } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

  let openMenuId = $state<string | null>(null)
  // Opening from closed animates; sliding from one open menu to the next swaps
  // instantly, the way a native menubar does.
  let switching = $state(false)

  function toggle(menuId: string): void {
    switching = false
    openMenuId = openMenuId === menuId ? null : menuId
  }

  // Standard menubar affordance: while one menu is open, hovering another
  // top-level switches to it.
  function hover(menuId: string): void {
    if (!openMenuId || openMenuId === menuId) return
    switching = true
    openMenuId = menuId
  }

  /** Keeps focus where it was, so Edit actions reach the field or editor the user was in. */
  function keepFocus(event: MouseEvent): void {
    event.preventDefault()
  }

  function runItem(item: MenuItem): void {
    openMenuId = null
    menu.run(item)
  }

  function onWindowPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-menubar]')) return
    switching = false
    openMenuId = null
  }

  /** Escape closes the open menu and is swallowed, so it never reaches a pane. */
  function onMenuKeyDown(event: KeyboardEvent): boolean {
    if (event.key !== 'Escape') return false
    switching = false
    openMenuId = null
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  $effect(() => {
    if (!openMenuId) return
    window.addEventListener('pointerdown', onWindowPointerDown, true)
    const stopMenuKeys = keyDispatch.subscribe(KeyPriority.menu, onMenuKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      stopMenuKeys()
    }
  })

  // Insert separators where the group changes.
  function withSeparators(items: MenuItem[]): { item: MenuItem; separator: boolean }[] {
    return items.map((item, index) => {
      const previous = items[index - 1]
      const separator = index > 0 && (previous.group ?? '') !== (item.group ?? '')
      return { item, separator }
    })
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex items-center" data-menubar onmousedown={keepFocus}>
  {#each menu.menus as top (top.id)}
    <div class="relative">
      <button
        class="rounded-md px-2 py-1 text-xs {openMenuId === top.id
          ? 'bg-surface text-default'
          : 'text-dim hover:text-default'}"
        onclick={() => toggle(top.id)}
        onpointerenter={() => hover(top.id)}
      >
        {top.label}
      </button>
      {#if openMenuId === top.id}
        <div
          class="absolute left-0 top-full z-overlay mt-1 min-w-52 origin-top-left rounded-lg border border-line bg-elevated py-1 shadow-overlay"
          in:scale={{ duration: switching ? 0 : 120, start: 0.96, opacity: 0, easing: cubicOut }}
          out:fade={{ duration: switching ? 0 : 80 }}
        >
          {#each withSeparators(menu.itemsFor(top.id)) as entry (entry.item.id)}
            {#if entry.separator}
              <div class="my-1 border-t border-line"></div>
            {/if}
            <button
              class="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs text-muted hover:bg-hover hover:text-default"
              onclick={() => runItem(entry.item)}
            >
              <span class="flex-1 truncate">{entry.item.label}</span>
              {#if entry.item.accelerator}
                <span class="font-mono text-2xs text-dim">{entry.item.accelerator}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>
