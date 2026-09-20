// The Code view — the layout grove opens with — and the two bridges that put
// what is registered into the command palette: every view, and every pane a
// user can ask for by name.
//
// A view is a whole-screen split tree; a pane is one window inside one. Most
// features only want a pane, and the pane bridge is what gets them a palette
// entry for it, so nothing has to register a view it does not need.

import type { Context } from '@neoworks/extension-system'
import { untrack } from 'svelte'
import { buildDefaultTree } from '../../lib/layout.svelte'

export const views = {
  name: 'core/views',
  inject: ['views', 'panes', 'commands', 'menu', 'layout'],

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

    ctx.effect(() => bridgeViewsToCommandsAndMenu(ctx), 'view:switcher-bridge')
    ctx.effect(() => bridgePanesToCommands(ctx), 'pane:palette-bridge')
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

/**
 * Keep one palette command per openable pane. Opening is `ensurePane`, which
 * focuses the window already showing the pane when there is one — so the
 * command reads as "take me to it" rather than "give me another".
 */
function bridgePanesToCommands(ctx: Context): () => void {
  return $effect.root(() => {
    $effect(() => {
      const list = ctx.panes.openableTypes()
      return untrack(() =>
        ctx.commands.registerAll(
          list.map((type) => ({
            id: `pane.${type.id}`,
            title: type.title,
            group: 'View',
            keywords: type.keywords,
            run: () => ctx.layout.ensurePane(type.id)
          }))
        )
      )
    })
  })
}
