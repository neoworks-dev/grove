// Core bindings, registered on app start. Plugins add their own via
// keymap.registerBindings — nothing here is special. The which-key overlay
// renders whatever is registered, so descriptions double as help text.
// Keys use the canonical sequence grammar: a "<Leader> …" prefix and bracketed
// modifier chords like "<Ctrl-H>" (spatial navigation, rebindable like the rest).

import { keymap } from './keymap.svelte'
import { commands } from './commands.svelte'
import { layout } from './layout.svelte'
import { bufferMenu } from './buffermenu.svelte'

export function registerCoreBindings(): void {
  keymap.registerBindings([
    {
      id: 'leader.buffers',
      keys: '<Leader> b',
      context: 'global',
      group: 'Buffer',
      description: 'Buffer menu',
      run: () => bufferMenu.show()
    },
    {
      id: 'leader.palette',
      keys: '<Leader> p',
      context: 'global',
      group: 'Command',
      description: 'Command palette',
      run: () => commands.open()
    },
    {
      id: 'leader.tree',
      keys: '<Leader> e',
      context: 'global',
      group: 'Focus',
      description: 'Open file explorer',
      // Open/switch the sidebar to the Explorer (ensurePane), which focuses the
      // tree inside it — so the binding works even when the sidebar is closed.
      run: () => layout.ensurePane('files')
    },
    {
      id: 'leader.agent',
      keys: '<Leader> A',
      context: 'global',
      group: 'Focus',
      description: 'Open agent panel',
      run: () => layout.ensurePane('agent')
    },
    {
      id: 'leader.preferences',
      keys: '<Leader> ,',
      context: 'global',
      group: 'Settings',
      description: 'Open preferences',
      run: () => layout.ensurePane('preferences')
    },
    {
      id: 'leader.keybindings',
      keys: '<Leader> k',
      context: 'global',
      group: 'Settings',
      description: 'Open keyboard shortcuts',
      run: () => layout.ensurePane('keybindings')
    },
    {
      id: 'leader.cheatsheet',
      keys: '<Leader> ?',
      context: 'global',
      group: 'Help',
      description: 'Show all keybindings',
      run: () => keymap.toggleCheatsheet()
    },
    {
      id: 'terminal.toggle',
      keys: '<Ctrl-`>',
      context: 'global',
      group: 'Terminal',
      description: 'Toggle terminal',
      run: () => layout.togglePane('terminal')
    },
    // Spatial pane navigation — ordinary bindings now, so they show up in
    // which-key listings and stay rebindable.
    {
      id: 'pane.focus.h',
      keys: '<Ctrl-H>',
      context: 'global',
      group: 'Window',
      description: 'Focus pane left',
      run: () => keymap.movePane('h')
    },
    {
      id: 'pane.focus.j',
      keys: '<Ctrl-J>',
      context: 'global',
      group: 'Window',
      description: 'Focus pane down',
      run: () => keymap.movePane('j')
    },
    {
      id: 'pane.focus.k',
      keys: '<Ctrl-K>',
      context: 'global',
      group: 'Window',
      description: 'Focus pane up',
      run: () => keymap.movePane('k')
    },
    {
      id: 'pane.focus.l',
      keys: '<Ctrl-L>',
      context: 'global',
      group: 'Window',
      description: 'Focus pane right',
      run: () => keymap.movePane('l')
    },
    {
      id: 'pane.resize.grow',
      keys: '<Ctrl-]>',
      context: 'global',
      group: 'Window',
      description: 'Grow pane',
      run: () => layout.resizeFocused(10)
    },
    {
      id: 'pane.resize.shrink',
      keys: '<Ctrl-[>',
      context: 'global',
      group: 'Window',
      description: 'Shrink pane',
      run: () => layout.resizeFocused(-10)
    },
    {
      id: 'leader.pane.h',
      keys: '<Leader> w h',
      context: 'global',
      group: 'Window',
      description: 'Focus pane left',
      run: () => keymap.movePane('h')
    },
    {
      id: 'leader.pane.j',
      keys: '<Leader> w j',
      context: 'global',
      group: 'Window',
      description: 'Focus pane down',
      run: () => keymap.movePane('j')
    },
    {
      id: 'leader.pane.k',
      keys: '<Leader> w k',
      context: 'global',
      group: 'Window',
      description: 'Focus pane up',
      run: () => keymap.movePane('k')
    },
    {
      id: 'leader.pane.l',
      keys: '<Leader> w l',
      context: 'global',
      group: 'Window',
      description: 'Focus pane right',
      run: () => keymap.movePane('l')
    },
    // Window management (vim split semantics: v = side by side, s = stacked).
    {
      id: 'window.split.vertical',
      keys: '<Leader> w v',
      context: 'global',
      group: 'Window',
      description: 'Split window right',
      run: () => layout.splitFocused('row')
    },
    {
      id: 'window.split.horizontal',
      keys: '<Leader> w s',
      context: 'global',
      group: 'Window',
      description: 'Split window down',
      run: () => layout.splitFocused('column')
    },
    {
      id: 'window.close',
      keys: '<Leader> w q',
      context: 'global',
      group: 'Window',
      description: 'Close window',
      run: () => layout.closeFocused()
    },
    {
      id: 'window.move.h',
      keys: '<Leader> w H',
      context: 'global',
      group: 'Window',
      description: 'Move window left',
      run: () => layout.moveFocused('h')
    },
    {
      id: 'window.move.j',
      keys: '<Leader> w J',
      context: 'global',
      group: 'Window',
      description: 'Move window down',
      run: () => layout.moveFocused('j')
    },
    {
      id: 'window.move.k',
      keys: '<Leader> w K',
      context: 'global',
      group: 'Window',
      description: 'Move window up',
      run: () => layout.moveFocused('k')
    },
    {
      id: 'window.move.l',
      keys: '<Leader> w L',
      context: 'global',
      group: 'Window',
      description: 'Move window right',
      run: () => layout.moveFocused('l')
    }
  ])

  commands.registerAll([
    {
      id: 'window.splitRight',
      title: 'Window: Split Right',
      group: 'Window',
      keywords: 'split vertical pane window',
      run: () => layout.splitFocused('row')
    },
    {
      id: 'window.splitDown',
      title: 'Window: Split Down',
      group: 'Window',
      keywords: 'split horizontal pane window',
      run: () => layout.splitFocused('column')
    },
    {
      id: 'window.close',
      title: 'Window: Close',
      group: 'Window',
      keywords: 'close pane window',
      run: () => layout.closeFocused()
    },
    {
      id: 'preferences.open',
      title: 'Preferences: Open Settings',
      group: 'Settings',
      keywords: 'settings options configure preferences',
      run: () => layout.ensurePane('preferences')
    },
    {
      id: 'keybindings.open',
      title: 'Preferences: Keyboard Shortcuts',
      group: 'Settings',
      keywords: 'keyboard shortcuts keybindings keys rebind',
      run: () => layout.ensurePane('keybindings')
    },
    {
      id: 'help.keybindings',
      title: 'Help: Keybindings Cheatsheet',
      group: 'Help',
      keywords: 'keys shortcuts help cheatsheet which key reference',
      run: () => keymap.toggleCheatsheet()
    },
    {
      id: 'terminal.toggle',
      title: 'Terminal: Toggle',
      group: 'Terminal',
      keywords: 'terminal shell console pty command line',
      run: () => layout.togglePane('terminal')
    },
    {
      id: 'nvim.open',
      title: 'Editor: Open Neovim Pane',
      group: 'Editor',
      keywords: 'neovim nvim vim editor embedded',
      run: () => layout.showCenterPane('nvim')
    }
  ])
}
