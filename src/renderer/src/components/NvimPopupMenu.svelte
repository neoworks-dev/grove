<script lang="ts">
  // Neovim's right-click menu as a real menu. Entries arrive from the bundled
  // config's <RightMouse> mapping (see lib/nvim/popupMenu.svelte.ts); only the
  // ones nvim enabled for the click are listed. Fix with Agent is listed as
  // one entry per agent the line's problem could go to.
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte'
  import { store } from '../lib/store.svelte'
  import {
    editorProblem,
    fixMenuItems,
    fixTargets,
    fixWithAgent,
    readEditorProblem,
    type EditorFixContext
  } from '../lib/agents/fixWithAgent'
  import {
    nvimPopupMenu,
    type NvimPopupEntry,
    type NvimPopupMenu as NvimPopupMenuState
  } from '../lib/nvim/popupMenu.svelte'

  // Where focus was when the menu opened: the editor's hidden input, which
  // clicking an entry would otherwise leave stranded.
  let returnFocusTo: HTMLElement | null = null

  // The bundled config's entry that hands the cursor line's diagnostics to an agent.
  const FIX_ENTRY = 'Fix with Agent'

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

  // The entry run through nvim's own :emenu rather than this menu: nobody picked
  // an agent, so it goes to the worktree's own.
  $effect(() => {
    return window.workbench.on('event:nvim-notify', (payload) => {
      const event = payload as { method: string; args: unknown[] }
      if (event.method !== 'grove_fix_with_agent') return
      const worktreePath = store.selectedWorktreeId
      if (!worktreePath) return
      const problem = editorProblem(worktreePath, event.args?.[0] as EditorFixContext)
      void fixWithAgent(worktreePath, problem, fixTargets(worktreePath)[0])
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
      if (name === FIX_ENTRY) {
        list.push(...fixItems(menu))
        continue
      }
      list.push({ label: name, action: () => nvimPopupMenu.run(menu, name) })
    }
    while (list.length > 0 && list[list.length - 1].divider) list.pop()
    return list
  }

  /** Fix with Agent as one entry per agent, for the worktree the editor shows. */
  function fixItems(menu: NvimPopupMenuState): MenuItem[] {
    const worktreePath = store.selectedWorktreeId
    if (!worktreePath) return []
    return fixMenuItems(worktreePath, () => readEditorProblem(menu.nvimId, worktreePath))
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
