// Git changes: the working-tree diff list in the sidebar, which drives the
// floating hunk review overlay in the editor.

import GitDiff from 'phosphor-svelte/lib/GitDiff'
import type { Context } from '@neoworks/extension-system'
import GitChangesView from '../../components/GitChangesView.svelte'
import { repoOpen } from './guards'

export const gitChanges = {
  name: 'core/git-changes',
  inject: ['sidebar'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.sidebar.registerView({
          id: 'changes',
          title: 'Git Changes',
          icon: GitDiff,
          order: 3,
          component: GitChangesView,
          when: repoOpen
        }),
      'sidebar:changes'
    )
  }
}
