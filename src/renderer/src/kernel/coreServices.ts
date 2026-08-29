// Publishes Grove's existing registries as kernel services, so a plugin can
// inject them and register through `ctx.effect` instead of hand-tracking
// disposers.
//
// These are deliberately the singletons themselves rather than Service
// subclasses wrapping them. Two reasons: the registries already expose exactly
// the right shape (`register(x) => dispose`), and their reactive state is
// compiled by Svelte into private class fields — a Service subclass would be
// re-created through `Object.create(instance)` by `isolate`/`intercept`, and
// reading an inherited rune accessor with a derived `this` throws on the
// private field. Facades that need behaviour of their own (sidebar, editor,
// panel) are Service subclasses that keep their state in plain objects.
//
// The rail-launcher and bottom-panel registries are deliberately absent here:
// they belong to the sidebar and panel host services, which own those surfaces.

import type { Context } from '@neoworks/extension-system'
import { commands } from '../lib/commands.svelte'
import { keymap } from '../lib/keymap.svelte'
import { panes } from '../lib/panes.svelte'
import { views } from '../lib/views.svelte'
import { statusBar } from '../lib/statusbar.svelte'
import { menu } from '../lib/menu.svelte'
import { overlays } from '../lib/overlays.svelte'
import { settings } from '../lib/settings.svelte'
import { dialogs } from '../lib/dialogs.svelte'
import { layout } from '../lib/layout.svelte'
import { store } from '../lib/store.svelte'

declare module '@neoworks/extension-system' {
  interface Context {
    commands: typeof commands
    keymap: typeof keymap
    panes: typeof panes
    views: typeof views
    statusbar: typeof statusBar
    menu: typeof menu
    overlays: typeof overlays
    settings: typeof settings
    dialogs: typeof dialogs
    layout: typeof layout
    workspace: typeof store
  }
}

export const coreServices = {
  name: 'core/services',

  /** Provide every core registry; each provide reverts if this plugin unloads. */
  apply(ctx: Context): void {
    ctx.provide('commands', commands)
    ctx.provide('keymap', keymap)
    ctx.provide('panes', panes)
    ctx.provide('views', views)
    ctx.provide('statusbar', statusBar)
    ctx.provide('menu', menu)
    ctx.provide('overlays', overlays)
    ctx.provide('settings', settings)
    ctx.provide('dialogs', dialogs)
    ctx.provide('layout', layout)
    ctx.provide('workspace', store)
  }
}
