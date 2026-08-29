// Views: named split-tree layouts shown in the header switcher, plus the bridge
// that mirrors every registered view into the command palette and the View menu.

import type { Context } from '@neoworks/extension-system'
import { untrack } from 'svelte'
import { buildDefaultTree } from '../../lib/layout.svelte'
import { createLeaf } from '../../lib/layoutTree'

export const views = {
  name: 'core/views',
  inject: ['views', 'commands', 'menu', 'layout'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.views.register({
          id: 'code',
          label: 'Code',
          order: 1,
          buildTree: () => buildDefaultTree(),
          initialFocus: 'nvim'
        }),
      'view:code'
    )

    // Views define only the center split tree; the agent panel lives in the
    // right dock, shared across views.
    ctx.effect(
      () =>
        ctx.views.register({
          id: 'dashboard',
          label: 'Dashboard',
          order: 2,
          buildTree: () => createLeaf('dashboard')
        }),
      'view:dashboard'
    )

    ctx.effect(() => bridgeViewsToCommandsAndMenu(ctx), 'view:switcher-bridge')
  }
}

/**
 * Keep one palette command and one View-menu item per registered view, so a
 * plugin that adds a view gets both for free. The registry writes are untracked:
 * register() also reads its own $state list, which would otherwise make this
 * effect depend on what it writes and loop.
 */
function bridgeViewsToCommandsAndMenu(ctx: Context): () => void {
  return $effect.root(() => {
    $effect(() => {
      const list = ctx.views.views
      return untrack(() => {
        const disposeCommands = ctx.commands.registerAll(
          list.map((view) => ({
            id: `view.${view.id}`,
            title: `View: ${view.label}`,
            group: 'View',
            run: () => ctx.layout.switchView(view.id)
          }))
        )
        const disposeItems = ctx.menu.registerItems(
          list.map((view) => ({
            id: `view.switch.${view.id}`,
            menuId: 'view',
            label: view.label,
            group: '1-views',
            order: view.order,
            run: () => ctx.layout.switchView(view.id)
          }))
        )
        return () => {
          disposeCommands()
          disposeItems()
        }
      })
    })
  })
}
