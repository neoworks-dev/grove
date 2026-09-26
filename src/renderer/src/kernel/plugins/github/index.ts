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
import { handlePrReviewKey, openItemByNumber } from './store.svelte'
import { layout } from '../../../lib/layout.svelte'
import { registerShowHandler } from '../../../lib/agents/show'
import { messageCards } from '../../../lib/agents/messageCards.svelte'
import GithubReferenceCard from './GithubReferenceCard.svelte'
import { githubReferences } from './references'

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

    // An agent pointing at an issue or pull request opens it here.
    ctx.effect(
      () =>
        registerShowHandler('github', async (_worktree, target) => {
          layout.ensurePane('github')
          await openItemByNumber(target.number)
        }),
      'agents:show-github'
    )

    // An issue or pull request an agent's message names gets a card under it.
    ctx.effect(
      () =>
        messageCards.register({
          id: 'github',
          find: githubReferences,
          component: GithubReferenceCard
        }),
      'agents:github-cards'
    )
  }
}
