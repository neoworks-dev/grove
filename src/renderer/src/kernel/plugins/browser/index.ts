// The browser preview: a pane on the worktree's dev server that the worktree's
// agents can drive, and the activity line that shows them doing it.

import GlobeSimple from 'phosphor-svelte/lib/GlobeSimple'
import type { Context } from '@neoworks/extension-system'
import type { BrowserActivity } from '../../../../../shared/types'
import BrowserPane from './BrowserPane.svelte'
import { browserState } from './browserState.svelte'
import { repoOpen } from '../guards'

export const browser = {
  name: 'core/browser',
  inject: ['panes'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'browser',
          title: 'Browser',
          icon: GlobeSimple,
          component: BrowserPane,
          containerClass: 'bg-elevated',
          preferredOrientation: 'row',
          minWidth: 320,
          keywords: 'browser preview web page dev server localhost devtools',
          when: repoOpen
        }),
      'pane:browser'
    )

    ctx.effect(
      () =>
        window.workbench.on('event:browser-activity', (payload) => {
          browserState.noteActivity(payload as BrowserActivity)
        }),
      'browser:activity'
    )
  }
}
