// Core bindings, registered on app start. Plugins add their own via
// keymap.registerBindings — nothing here is special. The which-key overlay
// renders whatever is registered, so descriptions double as help text.
// Keys use the canonical sequence grammar: explicit "leader …" prefixes and
// modifier chords like "ctrl+h" (spatial navigation, rebindable like the rest).

import { keymap } from './keymap.svelte'
import { commands } from './commands.svelte'
import { layout } from './layout.svelte'
import { bufferMenu } from './buffermenu.svelte'

export function registerCoreBindings(): void {
  keymap.registerBindings([
    {
      id: 'leader.buffers',
      keys: 'leader b',
      context: 'global',
      group: 'Buffer',
      description: 'Buffer menu',
      run: () => bufferMenu.show()
    },
    {
      id: 'leader.palette',
      keys: 'leader p',
      context: 'global',
      group: 'Command',
      description: 'Command palette',
      run: () => commands.open()
    },
    {
      id: 'leader.tree',
      keys: 'leader e',
      context: 'global',
      group: 'Focus',
      description: 'Focus file tree',
      run: () => keymap.focusPane('tree')
    },
    {
      id: 'leader.preferences',
      keys: 'leader ,',
      context: 'global',
      group: 'Settings',
      description: 'Open preferences',
      run: () => layout.ensurePane('preferences')
    },
    {
      id: 'leader.keybindings',
      keys: 'leader k',
      context: 'global',
      group: 'Settings',
      description: 'Open keyboard shortcuts',
      run: () => layout.ensurePane('keybindings')
    },
    // Spatial pane navigation — ordinary bindings now, so they show up in
    // which-key listings and stay rebindable.
    {
      id: 'pane.focus.h',
      keys: 'ctrl+h',
      context: 'global',
      group: 'Window',
      description: 'Focus pane left',
      run: () => keymap.movePane('h')
    },
    {
      id: 'pane.focus.j',
      keys: 'ctrl+j',
      context: 'global',
      group: 'Window',
      description: 'Focus pane down',
      run: () => keymap.movePane('j')
    },
    {
      id: 'pane.focus.k',
      keys: 'ctrl+k',
      context: 'global',
      group: 'Window',
      description: 'Focus pane up',
      run: () => keymap.movePane('k')
    },
    {
      id: 'pane.focus.l',
      keys: 'ctrl+l',
      context: 'global',
      group: 'Window',
      description: 'Focus pane right',
      run: () => keymap.movePane('l')
    },
    {
      id: 'leader.pane.h',
      keys: 'leader w h',
      context: 'global',
      group: 'Window',
      description: 'Focus pane left',
      run: () => keymap.movePane('h')
    },
    {
      id: 'leader.pane.j',
      keys: 'leader w j',
      context: 'global',
      group: 'Window',
      description: 'Focus pane down',
      run: () => keymap.movePane('j')
    },
    {
      id: 'leader.pane.k',
      keys: 'leader w k',
      context: 'global',
      group: 'Window',
      description: 'Focus pane up',
      run: () => keymap.movePane('k')
    },
    {
      id: 'leader.pane.l',
      keys: 'leader w l',
      context: 'global',
      group: 'Window',
      description: 'Focus pane right',
      run: () => keymap.movePane('l')
    },
    // Window management (vim split semantics: v = side by side, s = stacked).
    {
      id: 'window.split.vertical',
      keys: 'leader w v',
      context: 'global',
      group: 'Window',
      description: 'Split window right',
      run: () => layout.splitFocused('row')
    },
    {
      id: 'window.split.horizontal',
      keys: 'leader w s',
      context: 'global',
      group: 'Window',
      description: 'Split window down',
      run: () => layout.splitFocused('column')
    },
    {
      id: 'window.close',
      keys: 'leader w q',
      context: 'global',
      group: 'Window',
      description: 'Close window',
      run: () => layout.closeFocused()
    },
    {
      id: 'window.move.h',
      keys: 'leader w H',
      context: 'global',
      group: 'Window',
      description: 'Move window left',
      run: () => layout.moveFocused('h')
    },
    {
      id: 'window.move.j',
      keys: 'leader w J',
      context: 'global',
      group: 'Window',
      description: 'Move window down',
      run: () => layout.moveFocused('j')
    },
    {
      id: 'window.move.k',
      keys: 'leader w K',
      context: 'global',
      group: 'Window',
      description: 'Move window up',
      run: () => layout.moveFocused('k')
    },
    {
      id: 'window.move.l',
      keys: 'leader w L',
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
    }
  ])
}
