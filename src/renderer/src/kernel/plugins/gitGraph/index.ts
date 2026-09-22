// Commit graph: the repository's whole history drawn as lanes, with the
// branches and tags on each commit, as a pane of its own and a tab in the
// bottom panel.

import GraphIcon from 'phosphor-svelte/lib/GraphIcon'
import type { Context } from '@neoworks/extension-system'
import GitGraphPane from './GitGraphPane.svelte'
import { repoOpen } from '../guards'

export const GIT_GRAPH_PANE = 'git-graph'

export const gitGraph = {
  name: 'core/git-graph',
  inject: ['panes', 'panel'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: GIT_GRAPH_PANE,
          title: 'Commit Graph',
          icon: GraphIcon,
          component: GitGraphPane,
          containerClass: 'bg-canvas',
          minWidth: 320,
          minHeight: 160,
          // Opens below the focused editor, like the panel, so a diff opened
          // from it lands beside it rather than replacing it.
          preferredOrientation: 'column',
          keywords: 'git graph commit history log branches gitlens',
          when: repoOpen
        }),
      'pane:git-graph'
    )

    ctx.effect(
      () =>
        ctx.panel.registerTab({
          id: GIT_GRAPH_PANE,
          title: 'Graph',
          icon: GraphIcon,
          paneTypeId: GIT_GRAPH_PANE,
          order: 30
        }),
      'panel:git-graph'
    )
  }
}
