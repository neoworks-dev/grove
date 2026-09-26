// Base app menu structure. Plugins add menus/items through the SDK.

import { menu, type MenuItem } from './menu.svelte'
import { commands } from './commands.svelte'
import { layout } from './layout.svelte'
import { store, switchTab } from './store.svelte'
import { runEditAction } from './editActions'

const DOCUMENTATION_URL = 'https://grove.neoworks.dev'
const NEOWORKS_URL = 'https://neoworks.dev'

const FILE_ITEMS: MenuItem[] = [
  {
    id: 'file.openRepo',
    menuId: 'file',
    label: 'Open Folder…',
    group: '1-open',
    order: 1,
    commandId: 'repo.open'
  },
  {
    id: 'file.closeTab',
    menuId: 'file',
    label: 'Close Tab',
    group: '5-close',
    order: 1,
    accelerator: '␣ b d',
    when: () => store.activeTabPath !== null,
    run: closeActiveTab
  }
]

const EDIT_ITEMS: MenuItem[] = [
  { id: 'edit.undo', menuId: 'edit', label: 'Undo', group: '1-history', order: 1, run: () => runEditAction('undo') },
  { id: 'edit.redo', menuId: 'edit', label: 'Redo', group: '1-history', order: 2, run: () => runEditAction('redo') },
  { id: 'edit.cut', menuId: 'edit', label: 'Cut', group: '2-clipboard', order: 1, run: () => runEditAction('cut') },
  { id: 'edit.copy', menuId: 'edit', label: 'Copy', group: '2-clipboard', order: 2, run: () => runEditAction('copy') },
  { id: 'edit.paste', menuId: 'edit', label: 'Paste', group: '2-clipboard', order: 3, run: () => runEditAction('paste') },
  {
    id: 'edit.selectAll',
    menuId: 'edit',
    label: 'Select All',
    group: '3-select',
    order: 1,
    run: () => runEditAction('selectAll')
  },
  { id: 'edit.find', menuId: 'edit', label: 'Find', group: '4-find', order: 1, run: () => runEditAction('find') },
  {
    id: 'edit.undoHistory',
    menuId: 'edit',
    label: 'Undo History',
    group: '4-find',
    order: 2,
    commandId: 'undotree.open',
    accelerator: '␣ s u'
  }
]

const VIEW_ITEMS: MenuItem[] = [
  {
    id: 'view.togglePanel',
    menuId: 'view',
    label: 'Toggle Bottom Panel',
    group: '3-panels',
    order: 0,
    commandId: 'panel.toggle',
    accelerator: '␣ j'
  },
  {
    id: 'view.toggleLogs',
    menuId: 'view',
    label: 'Toggle Logs Panel',
    group: '3-panels',
    order: 1,
    run: () => layout.togglePane('logs')
  },
  {
    id: 'view.toggleAgent',
    menuId: 'view',
    label: 'Toggle Agent Panel',
    group: '3-panels',
    order: 2,
    run: () => layout.togglePane('agent')
  },
  {
    id: 'view.focusMode',
    menuId: 'view',
    label: 'Focus Mode',
    group: '3-panels',
    order: 3,
    accelerator: '␣ z',
    run: () => layout.toggleFocusMode()
  },
  {
    id: 'view.palette',
    menuId: 'view',
    label: 'Command Palette…',
    group: '5-general',
    order: 1,
    accelerator: 'F1',
    run: () => commands.open()
  },
  {
    id: 'view.theme',
    menuId: 'view',
    label: 'Color Theme…',
    group: '5-general',
    order: 2,
    commandId: 'theme.switch'
  },
  {
    id: 'view.preferences',
    menuId: 'view',
    label: 'Preferences',
    group: '5-general',
    order: 3,
    run: () => layout.ensurePane('preferences'),
    accelerator: '␣ ,'
  },
  {
    id: 'view.keybindings',
    menuId: 'view',
    label: 'Keyboard Shortcuts',
    group: '5-general',
    order: 4,
    run: () => layout.ensurePane('keybindings'),
    accelerator: '␣ k'
  }
]

const GO_ITEMS: MenuItem[] = [
  {
    id: 'go.file',
    menuId: 'go',
    label: 'Go to File…',
    group: '1-find',
    order: 1,
    commandId: 'files.find',
    accelerator: '␣ ␣'
  },
  {
    id: 'go.symbol',
    menuId: 'go',
    label: 'Go to Symbol in Editor…',
    group: '1-find',
    order: 2,
    commandId: 'symbols.open',
    accelerator: '␣ s s'
  },
  {
    id: 'go.workspaceSymbol',
    menuId: 'go',
    label: 'Go to Symbol in Workspace…',
    group: '1-find',
    order: 3,
    commandId: 'symbols.workspace',
    accelerator: '␣ s S'
  },
  {
    id: 'go.nextTab',
    menuId: 'go',
    label: 'Next Tab',
    group: '2-tabs',
    order: 1,
    run: () => switchTab('next')
  },
  {
    id: 'go.previousTab',
    menuId: 'go',
    label: 'Previous Tab',
    group: '2-tabs',
    order: 2,
    run: () => switchTab('prev')
  }
]

const WINDOW_ITEMS: MenuItem[] = [
  {
    id: 'window.splitRight',
    menuId: 'window',
    label: 'Split Right',
    group: '1-split',
    order: 1,
    commandId: 'window.splitRight',
    accelerator: '␣ w v'
  },
  {
    id: 'window.splitDown',
    menuId: 'window',
    label: 'Split Down',
    group: '1-split',
    order: 2,
    commandId: 'window.splitDown',
    accelerator: '␣ w s'
  },
  {
    id: 'window.close',
    menuId: 'window',
    label: 'Close Window',
    group: '2-close',
    order: 1,
    commandId: 'window.close',
    accelerator: '␣ w q'
  }
]

const HELP_ITEMS: MenuItem[] = [
  {
    id: 'help.documentation',
    menuId: 'help',
    label: 'Documentation',
    group: '1-links',
    order: 1,
    run: () => window.workbench.openExternal(DOCUMENTATION_URL)
  },
  {
    id: 'help.neoworks',
    menuId: 'help',
    label: 'neoworks.dev',
    group: '1-links',
    order: 2,
    run: () => window.workbench.openExternal(NEOWORKS_URL)
  }
]

/** Closes the active editor tab, if one is open. */
function closeActiveTab(): void {
  if (!store.activeTabPath) {
    return
  }
  store.closeTab(store.activeTabPath)
}

/** Register the base menus and their items; returns the inverse. */
export function registerCoreMenu(): () => void {
  const disposeMenus = [
    menu.registerMenu({ id: 'file', label: 'File', order: 1 }),
    menu.registerMenu({ id: 'edit', label: 'Edit', order: 2 }),
    menu.registerMenu({ id: 'view', label: 'View', order: 3 }),
    menu.registerMenu({ id: 'go', label: 'Go', order: 4 }),
    menu.registerMenu({ id: 'window', label: 'Window', order: 5 }),
    menu.registerMenu({ id: 'help', label: 'Help', order: 6 })
  ]
  const disposeItems = menu.registerItems([
    ...FILE_ITEMS,
    ...EDIT_ITEMS,
    ...VIEW_ITEMS,
    ...GO_ITEMS,
    ...WINDOW_ITEMS,
    ...HELP_ITEMS
  ])

  return () => {
    disposeItems()
    for (const dispose of disposeMenus) {
      dispose()
    }
  }
}
