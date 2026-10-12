// GitHub: the issue and pull-request dashboard for the open repository, shown
// as a tab of the Git pane, and what hooks it into the editor and the agents.

import type { Context } from '@neoworks/extension-system'
import GithubPrCommentBox from './GithubPrCommentBox.svelte'
import { onPrReviewKey } from './prReview'
import { handlePrReviewKey, openItemByNumber } from './store.svelte'
import { showGitTab } from '../pane.svelte'
import { registerShowHandler } from '../../../../lib/agents/show'
import { messageCards } from '../../../../lib/agents/messageCards.svelte'
import GithubReferenceCard from './GithubReferenceCard.svelte'
import { githubReferences } from './references'

/** Registers the pull-request comment box and the agent hooks into GitHub. */
export function registerGithub(ctx: Context): void {
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
        showGitTab('github')
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
