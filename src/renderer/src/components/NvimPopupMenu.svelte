<script lang="ts">
  // Neovim's right-click menu as a real menu. Entries arrive from the bundled
  // config's <RightMouse> mapping (see lib/nvim/popupMenu.svelte.ts); only the
  // ones nvim enabled for the click are listed.
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte'
  import {
    nvimPopupMenu,
    type NvimPopupEntry,
    type NvimPopupMenu as NvimPopupMenuState
  } from '../lib/nvim/popupMenu.svelte'

  // Where focus was when the menu opened: the editor's hidden input, which
  // clicking an entry would otherwise leave stranded.
  let returnFocusTo: HTMLElement | null = null

  $effect(() => {
    return window.workbench.on('event:nvim-notify', (payload) => {
      const event = payload as { id: string; method: string; args: unknown[] }
      if (event.method !== 'grove_popup_menu') return
      const data = (event.args?.[0] ?? {}) as { mode?: unknown; items?: unknown }
      if (!Array.isArray(data.items) || typeof data.mode !== 'string') return
      returnFocusTo = document.activeElement as HTMLElement | null
      nvimPopupMenu.show(event.id, data.mode, data.items as NvimPopupEntry[])
    })
  })

  const items = $derived(menuItems(nvimPopupMenu.open))

  /** Enabled entries as menu items, with separators only between groups. */
  function menuItems(menu: NvimPopupMenuState | null): MenuItem[] {
    if (!menu) return []
    const list: MenuItem[] = []
    for (const entry of menu.entries) {
      if (entry.separator) {
        if (list.length > 0 && !list[list.length - 1].divider) list.push({ divider: true })
        continue
      }
      const name = entry.name
      if (!name || !entry.enabled) continue
      list.push({ label: name, action: () => nvimPopupMenu.run(menu, name) })
    }
    while (list.length > 0 && list[list.length - 1].divider) list.pop()
    return list
  }

  function close(): void {
    nvimPopupMenu.close()
    returnFocusTo?.focus()
    returnFocusTo = null
  }
</script>

{#if nvimPopupMenu.open && items.length > 0}
  <ContextMenu x={nvimPopupMenu.open.x} y={nvimPopupMenu.open.y} {items} onClose={close} />
{/if}
