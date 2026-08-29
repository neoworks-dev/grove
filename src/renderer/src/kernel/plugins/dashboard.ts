// Dashboard: the repository overview shown by the Dashboard view.

import type { Context } from '@neoworks/extension-system'
import Dashboard from '../../components/Dashboard.svelte'
import { CENTER_SLOT } from '../../lib/paneSlots'
import { repoOpen } from './guards'

export const dashboard = {
  name: 'core/dashboard',
  inject: ['panes'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'dashboard',
          title: 'Dashboard',
          component: Dashboard,
          slot: CENTER_SLOT,
          minWidth: 240,
          when: repoOpen
        }),
      'pane:dashboard'
    )
  }
}
