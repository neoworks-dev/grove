// Git changes: the working tree's changes down to the hunk, which drive the
// floating hunk review overlay in the editor, and the sections of the Git
// pane's left column. What is registered here is only their settings.

import type { Context } from '@neoworks/extension-system'
import { settings } from '../../../../lib/settings.svelte'
import { LAYOUT_SETTING, SHARE_PROMPT_BLAME_SETTING } from './changeTree'

/** Registers the Git settings. */
export function registerGitSettings(ctx: Context): void {
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
}
