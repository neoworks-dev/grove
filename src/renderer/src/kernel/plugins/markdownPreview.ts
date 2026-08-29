// Markdown preview: renders the active markdown buffer beside the editor.

import Eye from 'phosphor-svelte/lib/Eye'
import type { Context } from '@neoworks/extension-system'
import MarkdownPreviewPane from '../../components/MarkdownPreviewPane.svelte'
import { repoOpen } from './guards'

export const markdownPreview = {
  name: 'core/markdown-preview',
  inject: ['editor'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.editor.registerAuxPane({
          id: 'markdown',
          title: 'Markdown Preview',
          icon: Eye,
          component: MarkdownPreviewPane,
          orientation: 'row',
          centerSlot: true,
          minWidth: 320,
          when: repoOpen
        }),
      'pane:markdown'
    )
  }
}
