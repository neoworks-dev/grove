// Terminal: a shell pane, and the panel tab that hosts it.

import TerminalWindow from 'phosphor-svelte/lib/TerminalWindow'
import type { Context } from '@neoworks/extension-system'
import TerminalPane from '../../components/TerminalPane.svelte'
import { repoOpen } from './guards'

export const terminal = {
  name: 'core/terminal',
  inject: ['panes', 'panel'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'terminal',
          title: 'Terminal',
          icon: TerminalWindow,
          component: TerminalPane,
          containerClass: 'bg-surface',
          minHeight: 120,
          // 'terminal' forwards every key to the shell; ctrl+\ ctrl+n drops to
          // 'normal' so global chords (ctrl+hjkl, leader) work; 'i' returns.
          modes: ['terminal', 'normal'],
          ownsFontScale: true,
          when: repoOpen
        }),
      'pane:terminal'
    )

    ctx.effect(
      () =>
        ctx.panel.registerTab({
          id: 'terminal',
          title: 'Terminal',
          icon: TerminalWindow,
          paneTypeId: 'terminal',
          order: 10
        }),
      'panel:terminal'
    )
  }
}
