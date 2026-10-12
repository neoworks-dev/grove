// Git: everything about the repository in one plugin — Source Control in the
// sidebar, the commit graph, and the GitHub issues and pull requests behind
// its remote. One plugin so the three read one git state rather than each
// keeping its own copy that drifts from the others.

import type { Context } from '@neoworks/extension-system'
import { registerChanges } from './changes'
import { registerGraph } from './graph'
import { registerGithub } from './github'

export const git = {
  name: 'core/git',
  inject: ['sidebar', 'panes', 'panel', 'editor'],

  apply(ctx: Context): void {
    registerChanges(ctx)
    registerGraph(ctx)
    registerGithub(ctx)
  }
}
