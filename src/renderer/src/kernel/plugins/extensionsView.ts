// Extensions: the catalog of installable grammars, themes and LSP servers, plus
// the installed-plugin list, shown in the sidebar.

import PuzzlePiece from 'phosphor-svelte/lib/PuzzlePiece'
import type { Context } from '@neoworks/extension-system'
import ExtensionsView from '../../components/ExtensionsView.svelte'

export const extensionsView = {
  name: 'core/extensions',
  inject: ['sidebar'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.sidebar.registerView({
          id: 'extensions',
          title: 'Extensions',
          icon: PuzzlePiece,
          order: 6,
          component: ExtensionsView
        }),
      'sidebar:extensions'
    )
  }
}
