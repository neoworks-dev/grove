// Git changes: the source-control view in the sidebar — branch, commit box,
// staged and unstaged changes down to the hunk — which drives the floating hunk
// review overlay in the editor.

import GitDiff from 'phosphor-svelte/lib/GitDiff'
import type { Context } from '@neoworks/extension-system'
import GitChangesView from './GitChangesView.svelte'
import { repoOpen } from '../guards'
import { settings } from '../../../lib/settings.svelte'
import { LAYOUT_SETTING } from './changeTree'

export const gitChanges = {
  name: 'core/git-changes',
  inject: ['sidebar'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        settings.registerSchemas({
          contributorId: 'git',
          title: 'Git',
          settings: [
            {
              key: LAYOUT_SETTING,
              type: 'enum',
              default: 'tree',
              title: 'Changes Layout',
              description: 'Show changed files as a folder tree or as a flat list of paths.',
              category: 'Git',
              enumValues: [
                { value: 'tree', label: 'Tree' },
                { value: 'list', label: 'List' }
              ]
            }
          ]
        }),
      'settings:git'
    )

    ctx.effect(
      () =>
        ctx.sidebar.registerView({
          id: 'changes',
          title: 'Source Control',
          icon: GitDiff,
          order: 3,
          component: GitChangesView,
          containerClass: 'bg-surface',
          when: repoOpen
        }),
      'sidebar:changes'
    )
  }
}
