// Git: everything about the repository in one pane. Its Repository tab is laid
// out around the commit graph — refs down the left, the graph with the working
// tree as its top row, and the selected row's changes or details beside it —
// and its Launchpad tab holds the pull requests and issues behind the remote. One
// plugin so they all read one git state rather than each keeping its own copy
// that drifts from the others.

import GitDiffIcon from 'phosphor-svelte/lib/GitDiffIcon'
import type { Context } from '@neoworks/extension-system'
import GitPane from './GitPane.svelte'
import { registerGitSettings } from './changes'
import { registerGithub } from './github'
import { GIT_PANE, showGitTab, type GitTab } from './pane.svelte'
import { repoOpen } from '../guards'
import { CENTER_SLOT } from '../../../lib/paneSlots'

export const git = {
  name: 'core/git',
  inject: ['panes', 'editor', 'commands', 'keymap'],

  apply(ctx: Context): void {
    registerGitSettings(ctx)
    registerGithub(ctx)
    registerGitPane(ctx)
  }
}

/** Registers the Git pane, its key, and a command for each of its tabs. */
function registerGitPane(ctx: Context): void {
  // A center pane: the refs, the graph and the working tree side by side, and
  // the GitHub list with a thread beside it, all want the room. It opens below
  // the editor, across the whole center, rather than halving the editor's
  // width, and takes the rail slot Source Control had.
  ctx.effect(
    () =>
      ctx.panes.register({
        id: GIT_PANE,
        title: 'Git',
        icon: GitDiffIcon,
        component: GitPane,
        containerClass: 'bg-surface',
        slot: CENTER_SLOT,
        rail: { order: 3 },
        preferredOrientation: 'column',
        minWidth: 320,
        minHeight: 160,
        keywords:
          'git source control scm changes commit stage graph history log branches gitlens github launchpad issues pull requests pr reviews gh',
        when: repoOpen
      }),
    'pane:git'
  )

  // Source Control's key, under the sidebar views' `<Leader> v`.
  ctx.effect(
    () =>
      ctx.keymap.registerBindings([
        {
          id: 'git.show',
          keys: '<Leader> v g',
          context: 'global',
          group: 'Sidebar',
          description: 'Git',
          run: () => showTabWhenRepoOpen('repo')
        }
      ]),
    'keymap:git.show'
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        id: 'git.showRepository',
        title: 'Show Repository',
        group: 'Git',
        keywords: 'git source control commit graph history log branches gitlens',
        run: () => showTabWhenRepoOpen('repo')
      }),
    'command:git.showRepository'
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        id: 'git.showGithub',
        title: 'Show Launchpad',
        group: 'Git',
        keywords: 'launchpad github issues pull requests pr reviews gh board calendar',
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
