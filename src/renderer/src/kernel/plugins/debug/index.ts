// Debugging: the Run and Debug sidebar view, the Debug Console (a pane and a
// bottom-panel tab), and the keys — F5/F9/F10/F11 as in most IDEs, and the
// same under <Leader> d. The sessions themselves run in the main process
// (src/main/debug); this plugin is the UI on them.

import BugIcon from 'phosphor-svelte/lib/BugIcon'
import TerminalIcon from 'phosphor-svelte/lib/TerminalIcon'
import type { Context } from '@neoworks/extension-system'
import type { KeyBinding } from '../../../lib/keymap.svelte'
import { layout } from '../../../lib/layout.svelte'
import { repoOpen } from '../guards'
import RunAndDebugView from './RunAndDebugView.svelte'
import DebugConsolePane from './DebugConsolePane.svelte'
import BreakpointEditBox from './BreakpointEditBox.svelte'
import { debug } from './store.svelte'

export const debugging = {
  name: 'core/debug',
  inject: ['sidebar', 'panes', 'panel', 'keymap', 'commands', 'editor'],

  apply(ctx: Context): void {
    ctx.effect(() => debug.start(), 'debug:store')

    ctx.effect(
      () =>
        ctx.sidebar.registerView({
          id: 'debug',
          title: 'Run and Debug',
          icon: BugIcon,
          order: 4,
          key: 'd',
          component: RunAndDebugView,
          when: repoOpen
        }),
      'sidebar:debug'
    )

    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'debugConsole',
          title: 'Debug Console',
          icon: TerminalIcon,
          component: DebugConsolePane,
          containerClass: 'bg-surface',
          preferredOrientation: 'column',
          minHeight: 100,
          keywords: 'debug console repl evaluate output debugger',
          when: repoOpen
        }),
      'pane:debugConsole'
    )

    ctx.effect(
      () =>
        ctx.panel.registerTab({
          id: 'debugConsole',
          title: 'Debug Console',
          icon: TerminalIcon,
          paneTypeId: 'debugConsole',
          order: 25
        }),
      'panel:debugConsole'
    )

    // A breakpoint's condition, hit count and log message are edited in a box
    // over the line itself, opened from the gutter or the edit key.
    ctx.effect(
      () =>
        ctx.editor.registerOverlay({
          id: 'debug.breakpoint-editor',
          component: BreakpointEditBox
        }),
      'overlay:debug-breakpoint-editor'
    )

    ctx.effect(() => ctx.keymap.registerBindings(debugBindings()), 'keymap:debug')
    ctx.effect(
      () =>
        ctx.commands.registerAll(
          debugBindings()
            .filter((binding) => binding.id.startsWith('debug.') && !binding.id.endsWith('.leader'))
            .map((binding) => ({
              id: binding.id,
              title: `Debug: ${binding.description}`,
              group: 'Debug',
              keywords: 'debug debugger breakpoint step',
              run: binding.run
            }))
        ),
      'commands:debug'
    )
  }
}

/** The debugger's keys: function keys as in most IDEs, mirrored under <Leader> d. */
function debugBindings(): KeyBinding[] {
  const actions: {
    id: string
    keys: string
    leader: string
    description: string
    run: () => void
  }[] = [
    {
      id: 'debug.continue',
      keys: '<F5>',
      leader: 'c',
      description: 'Start or continue',
      run: () => void debug.continueOrStart()
    },
    {
      id: 'debug.stop',
      keys: '<Shift-F5>',
      leader: 't',
      description: 'Stop',
      run: () => void debug.stop()
    },
    {
      id: 'debug.toggleBreakpoint',
      keys: '<F9>',
      leader: 'b',
      description: 'Toggle breakpoint',
      run: () => void debug.toggleBreakpointAtCursor()
    },
    {
      id: 'debug.editBreakpoint',
      keys: '<Shift-F9>',
      leader: 'B',
      description: 'Edit breakpoint (condition, hit count, log message)',
      run: () => void debug.editBreakpointAtCursor()
    },
    {
      id: 'debug.stepOver',
      keys: '<F10>',
      leader: 'O',
      description: 'Step over',
      run: () => void debug.stepOver()
    },
    {
      id: 'debug.stepInto',
      keys: '<F11>',
      leader: 'i',
      description: 'Step into',
      run: () => void debug.stepInto()
    },
    {
      id: 'debug.stepOut',
      keys: '<Shift-F11>',
      leader: 'o',
      description: 'Step out',
      run: () => void debug.stepOut()
    }
  ]
  const bindings: KeyBinding[] = []
  for (const action of actions) {
    bindings.push({
      id: action.id,
      keys: action.keys,
      context: 'global',
      group: 'Debug',
      description: action.description,
      run: action.run
    })
    bindings.push({
      id: `${action.id}.leader`,
      keys: `<Leader> d ${action.leader}`,
      context: 'global',
      group: 'Debug',
      description: action.description,
      run: action.run
    })
  }
  bindings.push({
    id: 'debug.console',
    keys: '<Leader> d r',
    context: 'global',
    group: 'Debug',
    description: 'Debug console',
    run: () => layout.ensurePane('debugConsole')
  })
  return bindings
}
