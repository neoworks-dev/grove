// Core leader bindings, registered on app start. Plugins add their own via
// keymap.registerBindings — nothing here is special. The which-key overlay
// renders whatever is registered, so descriptions double as help text.

import { keymap } from './keymap.svelte'
import { commands } from './commands.svelte'
import { search } from './search.svelte'
import { fileFinder } from './filefinder.svelte'
import { bufferMenu } from './buffermenu.svelte'

export function registerCoreBindings(): void {
  keymap.registerBindings([
    {
      id: 'leader.files',
      keys: 'space',
      context: 'global',
      group: 'Search',
      description: 'Search files by name',
      run: () => fileFinder.show()
    },
    {
      id: 'leader.search',
      keys: '/',
      context: 'global',
      group: 'Search',
      description: 'Search file contents (ripgrep)',
      run: () => search.show()
    },
    {
      id: 'leader.buffers',
      keys: 'b',
      context: 'global',
      group: 'Buffer',
      description: 'Buffer menu',
      run: () => bufferMenu.show()
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
    title: 'Search File Contents (ripgrep)',
    group: 'Search',
    keywords: 'grep ripgrep content find',
    run: () => search.show()
  })

  commands.register({
    id: 'files.find',
    title: 'Go to File (by name)',
    group: 'Search',
    keywords: 'open file name quick finder goto',
    run: () => fileFinder.show()
  })
}
