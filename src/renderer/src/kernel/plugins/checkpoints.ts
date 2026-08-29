// Checkpoints: restore points taken around agent runs, listed in the sidebar.

import ClockCounterClockwise from 'phosphor-svelte/lib/ClockCounterClockwise'
import type { Context } from '@neoworks/extension-system'
import CheckpointsView from '../../components/CheckpointsView.svelte'
import { repoOpen } from './guards'

export const checkpoints = {
  name: 'core/checkpoints',
  inject: ['sidebar'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.sidebar.registerView({
          id: 'checkpoints',
          title: 'Checkpoints',
          icon: ClockCounterClockwise,
          order: 5,
          component: CheckpointsView,
          when: repoOpen
        }),
      'sidebar:checkpoints'
    )
  }
}
