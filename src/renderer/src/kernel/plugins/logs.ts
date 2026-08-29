// Service logs: output of the processes Grove supervises per worktree.

import type { Context } from '@neoworks/extension-system'
import LogsPane from '../../components/LogsPane.svelte'

export const logs = {
  name: 'core/logs',
  inject: ['panes', 'commands', 'layout'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'logs',
          title: 'Logs',
          component: LogsPane,
          containerClass: 'bg-elevated',
          minHeight: 120
        }),
      'pane:logs'
    )

    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'view.toggleLogs',
          title: 'Toggle Logs Panel',
          group: 'View',
          run: () => ctx.layout.togglePane('logs')
        }),
      'command:view.toggleLogs'
    )
  }
}
