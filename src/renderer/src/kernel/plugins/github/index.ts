// GitHub: the issue and pull-request dashboard for the open repository. It is a
// center pane (it wants room for a list and a thread side by side) plus a named
// view, which gets it a palette command and a View-menu entry for free.

import type { Context } from '@neoworks/extension-system'
import GithubPane from './GithubPane.svelte'
import { CENTER_SLOT } from '../../../lib/paneSlots'
import { createLeaf } from '../../../lib/layoutTree'
import { repoOpen } from '../guards'

export const githubDashboard = {
  name: 'core/github',
  inject: ['panes', 'views'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'github',
          title: 'GitHub',
          component: GithubPane,
          slot: CENTER_SLOT,
          minWidth: 320,
          when: repoOpen
        }),
      'pane:github'
    )

    ctx.effect(
      () =>
        ctx.views.register({
          id: 'github',
          label: 'GitHub',
          order: 3,
          buildTree: () => createLeaf('github')
        }),
      'view:github'
    )
  }
}
