// Service logs: output of the processes Grove supervises per worktree.

import type { Context } from '@neoworks/extension-system'
import ScrollIcon from 'phosphor-svelte/lib/ScrollIcon'
import LogsPane from '../../components/LogsPane.svelte'

export const logs = {
  name: 'core/logs',
  inject: ['panes'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'logs',
          title: 'Logs',
          icon: ScrollIcon,
          component: LogsPane,
          containerClass: 'bg-elevated',
          minHeight: 120,
          keywords: 'logs output processes services stdout'
        }),
      'pane:logs'
    )
  }
}
