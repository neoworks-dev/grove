// Problems: LSP diagnostics, both as a pane beside the editor and as a tab in
// the bottom panel. Starting the diagnostics collector is part of the plugin, so
// unloading it stops the collector too.

import Warning from 'phosphor-svelte/lib/Warning'
import type { Context } from '@neoworks/extension-system'
import DiagnosticsPane from '../../components/DiagnosticsPane.svelte'
import { diagnostics as collector } from '../../lib/diagnostics.svelte'
import { repoOpen } from './guards'

export const diagnostics = {
  name: 'core/diagnostics',
  inject: ['editor', 'panel'],

  apply(ctx: Context): void {
    ctx.effect(() => collector.start(), 'diagnostics:collector')

    ctx.effect(
      () =>
        ctx.editor.registerAuxPane({
          id: 'diagnostics',
          title: 'Diagnostics',
          icon: Warning,
          component: DiagnosticsPane,
          orientation: 'column',
          centerSlot: true,
          minWidth: 320,
          minHeight: 100,
          when: repoOpen
        }),
      'pane:diagnostics'
    )

    ctx.effect(
      () =>
        ctx.panel.registerTab({
          id: 'diagnostics',
          title: 'Problems',
          icon: Warning,
          paneTypeId: 'diagnostics',
          order: 20
        }),
      'panel:diagnostics'
    )
  }
}
