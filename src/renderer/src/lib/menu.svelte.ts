// Header menu registry — the app menu (File, View, …) is a canonical control
// surface: base items register in coreMenu.ts, plugins add theirs through the
// SDK. Items either delegate to a registered command (preferred, avoids
// duplicating actions) or carry their own run function.

import { commands } from './commands.svelte'

export interface TopMenu {
  id: string
  label: string
  order: number
}

export interface MenuItem {
  id: string
  menuId: string
  label: string
  // Items are grouped; separators render between groups.
  group?: string
  order?: number
  // Display-only hint (real keys live in the keymap).
  accelerator?: string
  when?: () => boolean
  commandId?: string
  run?: () => void | Promise<void>
}

class MenuRegistry {
  menus = $state<TopMenu[]>([])
  items = $state<MenuItem[]>([])

  registerMenu(menu: TopMenu): () => void {
    const others = this.menus.filter((entry) => entry.id !== menu.id)
    this.menus = [...others, menu].sort((a, b) => a.order - b.order)
    return () => {
      this.menus = this.menus.filter((entry) => entry.id !== menu.id)
    }
  }

  registerItems(list: MenuItem[]): () => void {
    const ids = new Set(list.map((item) => item.id))
    const others = this.items.filter((item) => !ids.has(item.id))
    this.items = [...others, ...list]
    return () => {
      this.items = this.items.filter((item) => !ids.has(item.id))
    }
  }

  // Visible items of a menu, sorted by group then order, ready to render.
  itemsFor(menuId: string): MenuItem[] {
    return this.items
      .filter((item) => item.menuId === menuId)
      .filter((item) => !item.when || item.when())
      .sort(compareItems)
  }

  run(item: MenuItem): void {
    if (item.run) {
      void item.run()
      return
    }
    if (!item.commandId) return
    const command = commands.commands.find((entry) => entry.id === item.commandId)
    if (command) void command.run()
  }
}

function compareItems(a: MenuItem, b: MenuItem): number {
  const groupCompare = (a.group ?? '').localeCompare(b.group ?? '')
  if (groupCompare !== 0) return groupCompare
  return (a.order ?? 0) - (b.order ?? 0)
}

export const menu = new MenuRegistry()
