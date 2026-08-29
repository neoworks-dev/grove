// First-run setup wizard: workbench.yaml, default agent, then AGENTS.md. Lives
// in the sidebar so the flow stays visible while files open in the center.

import Sparkle from 'phosphor-svelte/lib/Sparkle'
import type { Context } from '@neoworks/extension-system'
import SetupPane from '../../components/SetupPane.svelte'
import { setup as setupFlow } from '../../lib/setup.svelte'
import { repoOpen } from './guards'

export const setup = {
  name: 'core/setup',
  inject: ['sidebar', 'commands', 'layout'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.sidebar.registerView({
          id: 'setup',
          title: 'Setup',
          icon: Sparkle,
          order: 7,
          component: SetupPane,
          minWidth: 220,
          when: repoOpen
        }),
      'sidebar:setup'
    )

    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'workspace.setup',
          title: 'Set Up This Workspace…',
          group: 'Repository',
          keywords:
            'onboarding wizard services config workbench.yaml agents claude style intro',
          run: async () => {
            await setupFlow.begin()
            ctx.layout.ensurePane('setup')
          }
        }),
      'command:workspace.setup'
    )
  }
}
