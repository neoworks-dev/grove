// Workbench chrome: the core menus, the core keybindings, and the commands that
// belong to no single feature (open a repository, dock and focus toggles,
// icon/color theme switching).

import type { Context } from '@neoworks/extension-system'
import { registerCoreMenu } from '../../lib/coreMenu'
import { registerCoreBindings } from '../../lib/bindings'
import { store, openRepoResult, applyIconPack } from '../../lib/store.svelte'
import { availablePacks } from '../../lib/icons'
import { themePicker } from '../../lib/themepicker.svelte'

export const workbench = {
  name: 'core/workbench',
  inject: ['commands', 'keymap', 'menu', 'layout'],

  apply(ctx: Context): void {
    ctx.effect(() => registerCoreMenu(), 'menu:core')
    ctx.effect(() => registerCoreBindings(), 'keymap:core')

    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'repo.open',
          title: 'Open Repository…',
          group: 'Repository',
          run: pickRepo
        }),
      'command:repo.open'
    )

    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'view.toggleRightDock',
          title: 'Toggle Right Panel',
          group: 'View',
          run: () => ctx.layout.toggleDock('right')
        }),
      'command:view.toggleRightDock'
    )

    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'view.toggleFocusMode',
          title: 'Toggle Focus Mode',
          group: 'View',
          keywords: 'zen distraction free fullscreen center',
          run: () => ctx.layout.toggleFocusMode()
        }),
      'command:view.toggleFocusMode'
    )

    // One command per available icon pack, discovered from the pack registry.
    for (const pack of availablePacks()) {
      ctx.effect(
        () =>
          ctx.commands.register({
            id: `icons.${pack.name}`,
            title: `Icon Theme: ${pack.label}`,
            group: 'Appearance',
            keywords: 'icon theme style',
            run: () => applyIconPack(pack.name)
          }),
        `command:icons.${pack.name}`
      )
    }

    // A single entry opens the theme picker (live-previews on focus, applies on
    // Enter) rather than one command per theme.
    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'theme.switch',
          title: 'Switch Color Theme',
          group: 'Appearance',
          keywords: 'color theme palette scheme dark light appearance',
          run: () => themePicker.show()
        }),
      'command:theme.switch'
    )
  }
}

/** Prompt for a repository directory and open it, surfacing failures in the shell. */
async function pickRepo(): Promise<void> {
  store.clearError()
  try {
    const result = await window.workbench.repo.pick()
    if (result) await openRepoResult(result)
  } catch (error) {
    store.setError((error as Error).message)
  }
}
