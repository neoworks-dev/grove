// Status bar: the core items pinned to the bottom strip. Plugins register more
// through the same service, left or right aligned.

import type { Context } from '@neoworks/extension-system'
import StatusMode from '../../components/StatusMode.svelte'
import StatusBranch from '../../components/StatusBranch.svelte'
import StatusClock from '../../components/StatusClock.svelte'
import StatusIntro from '../../components/StatusIntro.svelte'
import EditorBreadcrumbs from '../../components/EditorBreadcrumbs.svelte'

export const statusBar = {
  name: 'core/status-bar',
  inject: ['statusbar'],

  apply(ctx: Context): void {
    const items = [
      { id: 'mode', align: 'left' as const, order: 0, component: StatusMode },
      { id: 'git.branch', align: 'left' as const, order: 1, component: StatusBranch },
      { id: 'breadcrumbs', align: 'left' as const, order: 2, component: EditorBreadcrumbs },
      { id: 'clock', align: 'right' as const, order: 100, component: StatusClock },
      // Visible only while an AGENTS.md onboarding session runs but its pane is
      // hidden — one click returns to the flow.
      { id: 'intro.active', align: 'right' as const, order: 50, component: StatusIntro }
    ]
    for (const item of items) {
      ctx.effect(() => ctx.statusbar.register(item), `status:${item.id}`)
    }
  }
}
