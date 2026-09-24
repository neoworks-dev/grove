// Neovim's right-click menu, drawn by grove. The bundled config maps
// <RightMouse> to place the cursor, enable the PopUp entries that apply, and
// send them here as `grove_popup_menu` instead of drawing the menu into the
// grid, where its cells cannot be clicked. The pane that forwarded the click
// records where it happened, so the menu opens under the pointer.

export interface NvimPopupEntry {
  // The PopUp submenu name, as nvim's `:menu` lists it; sent back to run it.
  name?: string
  enabled?: boolean
  separator?: boolean
}

export interface NvimPopupMenu {
  nvimId: string
  // The PopUp mode the entries were read for: 'n', 'v' or 'i'.
  mode: string
  x: number
  y: number
  entries: NvimPopupEntry[]
}

class NvimPopupMenuStore {
  open = $state<NvimPopupMenu | null>(null)

  private lastClick = new Map<string, { x: number; y: number }>()

  /** Note where a right-click that went to this nvim landed. */
  noteRightClick(nvimId: string, x: number, y: number): void {
    this.lastClick.set(nvimId, { x, y })
  }

  /** Open the menu one nvim sent, under its last right-click. */
  show(nvimId: string, mode: string, entries: NvimPopupEntry[]): void {
    const click = this.lastClick.get(nvimId)
    if (!click) return
    if (!entries.some((entry) => entry.name && entry.enabled)) return
    this.open = { nvimId, mode, x: click.x, y: click.y, entries }
  }

  close(): void {
    this.open = null
  }

  /**
   * Run one entry of a menu in the nvim that offered it. Takes the menu rather
   * than reading `open`, which the menu closing has already cleared by the
   * time an entry's action runs.
   */
  run(menu: NvimPopupMenu, name: string): void {
    this.open = null
    void window.workbench.nvim
      .request(menu.nvimId, 'nvim_exec_lua', ['grove_run_popup_item(...)', [name, menu.mode]])
      .catch(() => {})
  }
}

export const nvimPopupMenu = new NvimPopupMenuStore()
