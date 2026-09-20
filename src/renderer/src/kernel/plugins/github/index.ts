// GitHub: the issue and pull-request dashboard for the open repository. A
// center pane (it wants room for a list and a thread side by side), reached
// from the palette through the pane bridge in `core/views` — it used to
// register a view of its own purely to get that entry, which meant asking for
// GitHub swapped the whole layout for it.

import type { Context } from '@neoworks/extension-system'
import GithubPane from './GithubPane.svelte'
import GithubPrCommentBox from './GithubPrCommentBox.svelte'
import { CENTER_SLOT } from '../../../lib/paneSlots'
import { repoOpen } from '../guards'
import { onPrReviewKey } from './prReview'
import { handlePrReviewKey } from './store.svelte'

export const githubDashboard = {
  name: 'core/github',
  inject: ['panes', 'editor'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'github',
          title: 'GitHub',
          component: GithubPane,
          slot: CENTER_SLOT,
          minWidth: 320,
          keywords: 'github issues pull requests pr reviews gh',
          when: repoOpen
        }),
      'pane:github'
    )

    // Reviewing happens on the buffer: the comment box opens over the line it
    // is about, and the keys that open it are Neovim's, mapped onto the diff.
    ctx.effect(
      () =>
        ctx.editor.registerOverlay({
          id: 'github.pr-comment',
          component: GithubPrCommentBox
        }),
      'overlay:github-pr-comment'
    )

    onPrReviewKey(handlePrReviewKey)
  }
}
