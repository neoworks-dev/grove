// Worktree switcher: the list of git worktrees in the sidebar.

import GitBranch from 'phosphor-svelte/lib/GitBranch'
import type { Context } from '@neoworks/extension-system'
import WorktreeSidebar from './WorktreeSidebar.svelte'

export const worktrees = {
  name: 'core/worktrees',
  inject: ['sidebar'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.sidebar.registerView({
          id: 'worktrees',
          title: 'Worktrees',
          icon: GitBranch,
          order: 2,
          component: WorktreeSidebar
        }),
      'sidebar:worktrees'
    )
  }
}
