// Git: everything about the repository in one plugin — Source Control in the
// sidebar, and the Git pane in the center with the commit graph and the GitHub
// issues and pull requests behind its remote as tabs. One plugin so they read
// one git state rather than each keeping its own copy that drifts from the
// others.

import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon'
import type { Context } from '@neoworks/extension-system'
import GitPane from './GitPane.svelte'
import { registerChanges } from './changes'
import { registerGithub } from './github'
import { GIT_PANE, showGitTab, type GitTab } from './pane.svelte'
import { repoOpen } from '../guards'
import { CENTER_SLOT } from '../../../lib/paneSlots'

export const git = {
  name: 'core/git',
  inject: ['sidebar', 'panes', 'editor', 'commands'],

  apply(ctx: Context): void {
    registerChanges(ctx)
    registerGithub(ctx)
    registerGitPane(ctx)
  }
}

/** Registers the Git pane, and a command for each of its tabs. */
function registerGitPane(ctx: Context): void {
  // A center pane: the graph and the GitHub list with a thread beside it both
  // want the room.
  ctx.effect(
    () =>
      ctx.panes.register({
        id: GIT_PANE,
        title: 'Git',
        icon: GitBranchIcon,
        component: GitPane,
        containerClass: 'bg-surface',
        slot: CENTER_SLOT,
        minWidth: 320,
        minHeight: 160,
        keywords:
          'git graph commit history log branches gitlens github issues pull requests pr reviews gh',
        when: repoOpen
      }),
    'pane:git'
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        id: 'git.showGraph',
        title: 'Show Commit Graph',
        group: 'Git',
        keywords: 'git graph commit history log branches gitlens',
        run: () => showTabWhenRepoOpen('graph')
      }),
    'command:git.showGraph'
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        id: 'git.showGithub',
        title: 'Show GitHub',
        group: 'Git',
        keywords: 'github issues pull requests pr reviews gh',
        run: () => showTabWhenRepoOpen('github')
      }),
    'command:git.showGithub'
  )
}

/** Opens the Git pane on a tab, unless there is no repository for it to show. */
function showTabWhenRepoOpen(tab: GitTab): void {
  if (!repoOpen()) return
  showGitTab(tab)
}
