// GitHub: the issue and pull-request dashboard for the open repository. A
// center pane (it wants room for a list and a thread side by side), reached
// from the palette through the pane bridge in `core/views` — it used to
// register a view of its own purely to get that entry, which meant asking for
// GitHub swapped the whole layout for it.

import type { Context } from '@neoworks/extension-system'
import GithubPane from './GithubPane.svelte'
import { CENTER_SLOT } from '../../../lib/paneSlots'
import { repoOpen } from '../guards'

export const githubDashboard = {
  name: 'core/github',
  inject: ['panes'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'github',
          title: 'GitHub',
          component: GithubPane,
          slot: CENTER_SLOT,
          minWidth: 320,
          keywords: 'github issues pull requests pr reviews gh',
          when: repoOpen
        }),
      'pane:github'
    )
  }
}
