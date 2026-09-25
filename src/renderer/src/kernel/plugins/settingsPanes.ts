// Settings family: preferences, keyboard shortcuts, and the permission grants
// review. They open beside the editor rather than replacing it.

import type { Context } from '@neoworks/extension-system'
import PreferencesPane from '../../components/PreferencesPane.svelte'
import KeyboardPane from '../../components/KeyboardPane.svelte'
import GrantsPane from '../../components/GrantsPane.svelte'

export const settingsPanes = {
  name: 'core/settings-panes',
  inject: ['editor'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.editor.registerAuxPane({
          id: 'preferences',
          title: 'Preferences',
          component: PreferencesPane,
          orientation: 'row',
          containerClass: 'bg-elevated',
          minWidth: 320,
          keywords: 'settings options configure preferences'
        }),
      'pane:preferences'
    )

    ctx.effect(
      () =>
        ctx.editor.registerAuxPane({
          id: 'keybindings',
          title: 'Keyboard Shortcuts',
          component: KeyboardPane,
          orientation: 'row',
          minWidth: 320,
          keywords: 'keyboard shortcuts keybindings keys rebind'
        }),
      'pane:keybindings'
    )

    ctx.effect(
      () =>
        ctx.editor.registerAuxPane({
          id: 'permissions',
          title: 'Permissions & Access',
          component: GrantsPane,
          orientation: 'row',
          containerClass: 'bg-elevated',
          minWidth: 320,
          keywords: 'permissions grants plugins apps access revoke security'
        }),
      'pane:permissions'
    )
  }
}
