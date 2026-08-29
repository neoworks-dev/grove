// Grove's plugin kernel. One root Context that everything mounts onto: core
// features, the UI surfaces that host them (sidebar, editor, panel), and the
// sandboxed third-party plugins.
//
// Two properties of the kernel are what the app leans on:
//   - every registration made through `ctx.effect` carries its own inverse, so
//     unloading a plugin cannot leak a command, pane, keybinding or listener;
//   - a plugin declaring `inject: ['sidebar']` only runs while that service
//     exists, and unwinds by itself when it goes away.
//
// Service keys live in one flat namespace with no version check, so core owns
// the bare names listed in coreServices.ts; anything contributed by a plugin
// must prefix its key with the plugin id.

import { Context } from '@neoworks/extension-system'

export const groveContext = new Context()
