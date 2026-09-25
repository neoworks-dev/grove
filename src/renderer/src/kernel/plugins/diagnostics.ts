// Problems: LSP diagnostics, both as a pane beside the editor and as a tab in
// the bottom panel. Starting the diagnostics collector is part of the plugin, so
// unloading it stops the collector too.

import Warning from 'phosphor-svelte/lib/Warning'
import type { Context } from '@neoworks/extension-system'
import DiagnosticsPane from '../../components/DiagnosticsPane.svelte'
import { diagnostics as collector } from '../../lib/diagnostics.svelte'
import { layout } from '../../lib/layout.svelte'
import { repoOpen } from './guards'

export const diagnostics = {
  name: 'core/diagnostics',
  inject: ['editor', 'panel'],

  apply(ctx: Context): void {
    ctx.effect(() => collector.start(), 'diagnostics:collector')
    ctx.effect(() => watchShowRequests(), 'diagnostics:show-requests')

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
          keywords: 'diagnostics errors warnings lsp lint problems trouble',
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

/**
 * Opens the Diagnostics pane whenever an editor asks for a diagnostics list:
 * the bundled config turns vim.diagnostic.setqflist/setloclist into a
 * `grove_show_diagnostics` notification instead of a quickfix split.
 */
function watchShowRequests(): () => void {
  return window.workbench.on('event:nvim-notify', (payload) => {
    const event = payload as { method: string }
    if (event.method !== 'grove_show_diagnostics') return
    layout.ensurePane('diagnostics')
  })
}
