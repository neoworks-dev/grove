// Core bindings, registered on app start. Plugins add their own via
// keymap.registerBindings — nothing here is special. The which-key overlay
// renders whatever is registered, so descriptions double as help text.
// Keys use the canonical sequence grammar: a "<Leader> …" prefix and bracketed
// modifier chords like "<Ctrl-H>" (spatial navigation, rebindable like the rest).

import { keymap } from './keymap.svelte'
import { commands } from './commands.svelte'
import { layout } from './layout.svelte'
import { bufferMenu } from './buffermenu.svelte'
import { store } from './store.svelte'
import { inlineEdit } from './inlineEdit.svelte'
import { symbolsOutline } from './symbolsOutline.svelte'
import { workspaceSymbols } from './workspaceSymbols.svelte'
import { undoTree } from './undotree.svelte'
import { dialogs } from './dialogs.svelte'
import { review } from './review.svelte'
import type { ReviewMode } from './inlineEditRef'

// One-line descriptor shown when the review mode is cycled.
const REVIEW_MODE_HINT: Record<ReviewMode, string> = {
  auto: 'auto — edits applied, no review',
  inline: 'inline — per-hunk accept/reject in the buffer',
  gated: 'gated — permission prompt before any write'
}

function cycleReviewMode(): void {
  const mode = inlineEdit.cycleMode()
  dialogs.notify({ level: 'info', message: `Edit mode: ${REVIEW_MODE_HINT[mode]}` })
}

/** Runs a tab operation on the active editor tab; does nothing when no tab is open. */
function onActiveTab(operation: (path: string) => void): void {
  if (!store.activeTabPath) {
    return
  }
  operation(store.activeTabPath)
}

/** Register the core keybindings and their palette commands; returns the inverse. */
export function registerCoreBindings(): () => void {
  const disposeBindings = keymap.registerBindings([
    // Buffer management, LazyVim's +buffer group on Grove's tabs.
    {
      id: 'leader.buffers',
      keys: '<Leader> b b',
      context: 'global',
      group: 'Buffer',
      description: 'Buffer menu',
      run: () => bufferMenu.show()
    },
    {
      id: 'buffer.close',
      keys: '<Leader> b d',
      context: 'global',
      group: 'Buffer',
      description: 'Close buffer',
      run: () => onActiveTab((path) => store.closeTab(path))
    },
    {
      id: 'buffer.closeOthers',
      keys: '<Leader> b o',
      context: 'global',
      group: 'Buffer',
      description: 'Close other buffers',
      run: () => onActiveTab((path) => store.closeOtherTabs(path))
    },
    {
      id: 'buffer.pin',
      keys: '<Leader> b p',
      context: 'global',
      group: 'Buffer',
      description: 'Toggle pin',
      run: () => onActiveTab((path) => store.togglePin(path))
    },
    {
      id: 'buffer.closeLeft',
      keys: '<Leader> b l',
      context: 'global',
      group: 'Buffer',
      description: 'Close buffers to the left',
      run: () => onActiveTab((path) => store.closeTabsToSide(path, 'left'))
    },
    {
      id: 'buffer.closeRight',
      keys: '<Leader> b r',
      context: 'global',
      group: 'Buffer',
      description: 'Close buffers to the right',
      run: () => onActiveTab((path) => store.closeTabsToSide(path, 'right'))
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
      keys: '<Leader> a',
      context: 'global',
      group: 'Focus',
      description: 'Open agent panel',
      run: () => layout.ensurePane('agent')
    },
    {
      // Editor-only: open the inline-edit prompt over the current selection.
      // The leader also starts in visual mode, so it fires on the live selection
      // without leaving visual; from normal mode it reads the last visual range.
      id: 'editor.inlineEdit',
      keys: '<Leader> i',
      context: 'editor',
      group: 'Agent',
      description: 'Inline edit selection',
      run: () => void inlineEdit.openPrompt()
    },
    {
      // Send the selection to the composer instead, to attach a longer prompt.
      id: 'editor.sendSelection',
      keys: '<Leader> I',
      context: 'editor',
      group: 'Agent',
      description: 'Send selection to composer',
      run: () => void inlineEdit.sendSelectionToComposer()
    },
    {
      id: 'editor.cycleMode',
      keys: '<Leader> m',
      context: 'global',
      group: 'Agent',
      description: 'Cycle edit review mode',
      run: cycleReviewMode
    },
    {
      id: 'leader.focusMode',
      keys: '<Leader> z',
      context: 'global',
      group: 'View',
      description: 'Toggle focus mode',
      run: () => layout.toggleFocusMode()
    },
    {
      // The left panel is content-driven (rail / <Leader> e open it); the right
      // panel has no rail entry, so it gets a direct toggle.
      id: 'leader.rightDock',
      keys: '<Leader> w ]',
      context: 'global',
      group: 'View',
      description: 'Toggle right panel',
      run: () => layout.toggleEdgePane('right')
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
      id: 'leader.diagnostics',
      keys: '<Leader> x x',
      context: 'global',
      group: 'Diagnostics',
      description: 'Open diagnostics',
      run: () => layout.ensurePane('diagnostics')
    },
    {
      id: 'leader.symbols',
      keys: '<Leader> s s',
      context: 'editor',
      group: 'Search',
      description: 'Symbol outline',
      run: () => symbolsOutline.toggle()
    },
    {
      id: 'leader.workspaceSymbols',
      keys: '<Leader> s S',
      context: 'global',
      group: 'Search',
      description: 'Search workspace symbols',
      run: () => workspaceSymbols.toggle()
    },
    {
      id: 'leader.undotree',
      keys: '<Leader> s u',
      context: 'editor',
      group: 'Search',
      description: 'Undo history',
      run: () => undoTree.toggle()
    },
    // Answering a review from the keyboard. Bare Enter/Escape would be the
    // editor's own keys, so these only exist while a review is open — `when`
    // keeps them out of the way (and out of which-key) the rest of the time.
    {
      id: 'review.acceptHunk',
      keys: '<Shift-Enter>',
      context: 'global',
      group: 'Review',
      description: 'Accept this change',
      when: () => review.active !== null,
      run: () => void review.decideCurrent('accepted')
    },
    {
      id: 'review.rejectHunk',
      keys: '<Shift-Escape>',
      context: 'global',
      group: 'Review',
      description: 'Reject this change',
      when: () => review.active !== null,
      run: () => void review.decideCurrent('rejected')
    },
    {
      id: 'review.acceptAll',
      keys: '<Enter> <Enter>',
      context: 'global',
      group: 'Review',
      description: 'Accept everything and finish',
      when: () => review.active !== null,
      run: () => void review.resolveAll('accepted')
    },
    {
      id: 'review.rejectAll',
      keys: '<Escape> <Escape>',
      context: 'global',
      group: 'Review',
      description: 'Reject everything and finish',
      when: () => review.active !== null,
      run: () => void review.resolveAll('rejected')
    },
    {
      id: 'terminal.toggle',
      keys: '<Ctrl-`>',
      context: 'global',
      group: 'Terminal',
      description: 'Toggle terminal',
      run: () => layout.togglePane('terminal')
    },
    {
      id: 'panel.toggle',
      keys: '<Leader> j',
      context: 'global',
      group: 'View',
      description: 'Toggle bottom panel',
      run: () => layout.togglePane('panel')
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
    // Per-pane font zoom (Ctrl +/-/0) is not bound here: the main process eats
    // those accelerators before the renderer sees a keydown, and routes them
    // back through the 'event:pane-zoom' IPC event. The key-based binding
    // grammar also can't reliably match +/-/= across keyboard layouts.
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

  const disposeCommands = commands.registerAll([
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
      id: 'panel.toggle',
      title: 'View: Toggle Bottom Panel',
      group: 'View',
      keywords: 'panel bottom terminal problems diagnostics output tabs',
      run: () => layout.togglePane('panel')
    },
    {
      id: 'symbols.open',
      title: 'Code: Symbol Outline',
      group: 'Code',
      keywords: 'symbols outline aerial functions classes methods navigate',
      run: () => symbolsOutline.toggle()
    },
    {
      id: 'symbols.workspace',
      title: 'Code: Search Workspace Symbols',
      group: 'Code',
      keywords: 'symbols workspace search functions classes methods go to symbol lsp',
      run: () => workspaceSymbols.toggle()
    },
    {
      id: 'undotree.open',
      title: 'Code: Undo History',
      group: 'Code',
      keywords: 'undo history undotree redo states time travel',
      run: () => undoTree.toggle()
    },
    {
      id: 'editor.inlineEdit',
      title: 'Agent: Inline Edit Selection',
      group: 'Agent',
      keywords: 'inline edit selection cmdk prompt agent range change',
      run: () => void inlineEdit.openPrompt()
    },
    {
      id: 'editor.sendSelection',
      title: 'Agent: Send Selection to Composer',
      group: 'Agent',
      keywords: 'inline edit selection reference mention agent range',
      run: () => void inlineEdit.sendSelectionToComposer()
    },
    {
      id: 'editor.cycleMode',
      title: 'Agent: Cycle Edit Review Mode',
      group: 'Agent',
      keywords: 'mode review auto inline gated accept edits permission',
      run: cycleReviewMode
    }
  ])

  return () => {
    disposeBindings()
    disposeCommands()
  }
}
