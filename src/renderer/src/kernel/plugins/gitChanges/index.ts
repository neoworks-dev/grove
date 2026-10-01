// Git changes: the source-control view in the sidebar — branch, commit box,
// staged and unstaged changes down to the hunk — which drives the floating hunk
// review overlay in the editor.

import GitDiff from 'phosphor-svelte/lib/GitDiff'
import type { Context } from '@neoworks/extension-system'
import GitChangesView from './GitChangesView.svelte'
import { repoOpen } from '../guards'
import { settings } from '../../../lib/settings.svelte'
import { LAYOUT_SETTING, SHARE_PROMPT_BLAME_SETTING } from './changeTree'

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
            },
            {
              key: SHARE_PROMPT_BLAME_SETTING,
              type: 'boolean',
              default: false,
              title: 'Share Prompt Blame',
              description:
                'Attach the prompt behind agent-written lines to commits as git notes, push them with the branch and fetch teammates\' notes on fetch. The prompts become readable by anyone with access to the remote.',
              category: 'Git'
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
          key: 'g',
          component: GitChangesView,
          when: repoOpen
        }),
      'sidebar:changes'
    )
  }
}
