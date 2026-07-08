// Core leader bindings, registered on app start. Plugins add their own via
// keymap.registerBindings — nothing here is special. The which-key overlay
// renders whatever is registered, so descriptions double as help text.

import { keymap } from './keymap.svelte'
import { commands } from './commands.svelte'
import { search } from './search.svelte'

export function registerCoreBindings(): void {
  keymap.registerBindings([
    {
      id: 'leader.search',
      keys: 'space',
      context: 'global',
      group: 'Search',
      description: 'Search files (ripgrep)',
      run: () => search.show()
    },
    {
      id: 'leader.palette',
      keys: 'p',
      context: 'global',
      group: 'Command',
      description: 'Command palette',
      run: () => commands.open()
    },
    {
      id: 'leader.tree',
      keys: 'e',
      context: 'global',
      group: 'Focus',
      description: 'Focus file tree',
      run: () => keymap.focusPane('tree')
    },
    {
      id: 'leader.pane.h',
      keys: 'w h',
      context: 'global',
      group: 'Window',
      description: 'Focus pane left',
      run: () => keymap.movePane('h')
    },
    {
      id: 'leader.pane.j',
      keys: 'w j',
      context: 'global',
      group: 'Window',
      description: 'Focus pane down',
      run: () => keymap.movePane('j')
    },
    {
      id: 'leader.pane.k',
      keys: 'w k',
      context: 'global',
      group: 'Window',
      description: 'Focus pane up',
      run: () => keymap.movePane('k')
    },
    {
      id: 'leader.pane.l',
      keys: 'w l',
      context: 'global',
      group: 'Window',
      description: 'Focus pane right',
      run: () => keymap.movePane('l')
    }
  ])

  commands.register({
    id: 'search.files',
    title: 'Search Files (ripgrep)',
    group: 'Search',
    keywords: 'grep ripgrep content find',
    run: () => search.show()
  })
}
