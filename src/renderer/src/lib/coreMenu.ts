// Base app menu structure. Plugins add menus/items through the SDK.

import { menu } from './menu.svelte'
import { commands } from './commands.svelte'
import { layout } from './layout.svelte'

export function registerCoreMenu(): void {
  menu.registerMenu({ id: 'file', label: 'File', order: 1 })
  menu.registerMenu({ id: 'view', label: 'View', order: 2 })

  menu.registerItems([
    {
      id: 'file.openRepo',
      menuId: 'file',
      label: 'Open Repository…',
      group: '1-open',
      order: 1,
      commandId: 'repo.open'
    },
    {
      id: 'file.goToFile',
      menuId: 'file',
      label: 'Go to File…',
      group: '1-open',
      order: 2,
      commandId: 'files.find',
      accelerator: '␣ ␣'
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
    }
  ])
}
