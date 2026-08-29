// File explorer: the worktree's file tree in the sidebar.

import Folder from 'phosphor-svelte/lib/Folder'
import type { Context } from '@neoworks/extension-system'
import FilesView from '../../components/FilesView.svelte'

export const explorer = {
  name: 'core/explorer',
  inject: ['sidebar'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.sidebar.registerView({
          id: 'files',
          title: 'Explorer',
          icon: Folder,
          order: 1,
          component: FilesView,
          containerClass: 'bg-surface'
        }),
      'sidebar:files'
    )
  }
}
