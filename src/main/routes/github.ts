// GitHub: the issue / pull-request dashboard, and the worktree ship-it calls
// (`gh pr create` / `gh pr merge`) that belong to the same CLI.
//
// Dashboard calls run against the repository root — gh resolves the repository
// from its remotes, and every worktree shares them.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as github from '../github'
import * as git from '../git'
import * as worktrees from '../worktrees'
import * as dashboard from '../githubDashboard'
import type {
  GithubIssueDraft,
  GithubPrDiff,
  GithubPrFile,
  GithubItemAction,
  GithubItemCommand,
  GithubLabelChange,
  GithubCloseReason,
  GithubAssigneeChange,
  GithubItemKind,
  GithubReviewDraft,
  GithubReviewEvent,
  GithubStateFilter,
  MergePrOptions,
  OpenPrOptions,
  PrCheckoutState,
  Worktree
} from '../../shared/types'
import { updateBlockedReason } from '../prCheckoutSync'

/**
 * The `pr-<n>` worktree for a pull request, checked out if it is not already.
 *
 * A worktree that is already there is not re-fetched: opening a file asks for
 * the checkout every time, and two network round trips in front of every click
 * is what that would cost. Following the pull request is `github:refreshPrCheckout`
 * and `github:updatePrCheckout`'s job.
 */
async function checkoutPullRequest(
  ctx: Context,
  number: number,
  baseRefName: string
): Promise<Worktree> {
  const { repoPath, config } = ctx.workbench.requireRepo()

  const name = `pr-${number}`
  const existing = (await ctx.workbench.refreshWorktrees()).find(
    (worktree: Worktree) => worktree.branch === name
  )
  if (existing) return existing

  await git.fetchPullRequestRefs(repoPath, number, baseRefName)

  // A branch left behind by a worktree that was removed: check it out again
  // rather than failing on the name, and leave whatever is on it alone —
  // reviewing a pull request is not a reason to throw away local commits.
  const branches = await git.listBranches(repoPath)
  const checkedOut = branches.local.includes(name)

  const created = await worktrees.createWorktree(
    repoPath,
    config,
    {
      name,
      newBranch: checkedOut ? undefined : name,
      checkoutBranch: checkedOut ? name : undefined,
      baseBranch: `refs/grove/pr/${number}/head`
    },
    (worktreeId, line) =>
      ctx.workbench.send('event:log', { worktreeId, source: 'service', name: 'setup', line })
  )
  await ctx.workbench.refreshWorktrees()
  return created
}

/** The `pr-<n>` worktree for a pull request, or undefined when it is not checked out. */
async function findPrWorktree(ctx: Context, number: number): Promise<Worktree | undefined> {
  const worktrees: Worktree[] = await ctx.workbench.refreshWorktrees()
  return worktrees.find((entry) => entry.branch === `pr-${number}`)
}

/** Where a pull request's checkout stands against the pull request, as last fetched. */
async function prCheckoutState(ctx: Context, number: number): Promise<PrCheckoutState> {
  const worktree = await findPrWorktree(ctx, number)
  const { target, blockedReason } = await dashboard.fetchPushTarget(
    ctx.workbench.requireRepo().repoPath,
    number
  )
  if (!worktree) {
    return {
      worktreeId: null,
      mergeInProgress: false,
      unresolved: 0,
      ahead: 0,
      behind: 0,
      dirty: false,
      updateBlockedReason: null,
      pushTarget: target,
      blockedReason
    }
  }
  const headRef = `refs/grove/pr/${number}/head`
  const position = {
    ahead: await git.commitsAhead(worktree.path, headRef),
    behind: await git.commitsBehind(worktree.path, headRef),
    dirty: await git.isDirty(worktree.path),
    mergeInProgress: await git.mergeInProgress(worktree.path)
  }
  return {
    worktreeId: worktree.id,
    unresolved: (await git.conflictedFiles(worktree.path)).length,
    ...position,
    updateBlockedReason: updateBlockedReason(position),
    pushTarget: target,
    blockedReason
  }
}

export const githubRoutes = {
  name: 'main/routes/github',
  inject: ['workbench', 'checkpoints'],

  apply(ctx: Context): void {
    // ── Dashboard (issues + pull requests) ────────────────────────
    route(ctx, 'github:status', () => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.fetchStatus(repoPath)
    })

    route(ctx, 'github:dashboard', (_e, options: { state: GithubStateFilter; limit: number }) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.fetchDashboard(repoPath, options)
    })

    route(ctx, 'github:item', (_e, kind: GithubItemKind, number: number) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.fetchItem(repoPath, kind, number)
    })

    // The pull request of each branch, for the worktree rows.
    route(ctx, 'github:branchPulls', () => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.fetchBranchPulls(repoPath)
    })

    route(ctx, 'github:labels', () => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.fetchLabels(repoPath)
    })

    route(ctx, 'github:milestones', () => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.fetchMilestones(repoPath)
    })

    route(
      ctx,
      'github:changeMilestone',
      (_e, kind: GithubItemKind, number: number, title: string | null) => {
        const { repoPath } = ctx.workbench.requireRepo()
        return dashboard.changeMilestone(repoPath, kind, number, title)
      }
    )

    route(
      ctx,
      'github:command',
      (_e, kind: GithubItemKind, number: number, command: GithubItemCommand) => {
        const { repoPath } = ctx.workbench.requireRepo()
        return dashboard.runItemCommand(repoPath, kind, number, command)
      }
    )

    route(ctx, 'github:transfer', (_e, number: number, destination: string) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.transferIssue(repoPath, number, destination)
    })

    route(ctx, 'github:setSubscription', (_e, nodeId: string, subscribed: boolean) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.setSubscription(repoPath, nodeId, subscribed)
    })

    route(ctx, 'github:mentionables', () => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.fetchMentionables(repoPath)
    })

    route(ctx, 'github:createIssue', (_e, draft: GithubIssueDraft) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.createIssue(repoPath, draft)
    })

    route(
      ctx,
      'github:changeLabels',
      (_e, kind: GithubItemKind, number: number, change: GithubLabelChange) => {
        const { repoPath } = ctx.workbench.requireRepo()
        return dashboard.changeLabels(repoPath, kind, number, change)
      }
    )

    route(
      ctx,
      'github:changeAssignees',
      (_e, kind: GithubItemKind, number: number, change: GithubAssigneeChange) => {
        const { repoPath } = ctx.workbench.requireRepo()
        return dashboard.changeAssignees(repoPath, kind, number, change)
      }
    )

    route(ctx, 'github:comment', (_e, kind: GithubItemKind, number: number, body: string) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.addComment(repoPath, kind, number, body)
    })

    route(
      ctx,
      'github:action',
      (
        _e,
        kind: GithubItemKind,
        number: number,
        action: GithubItemAction,
        merge?: MergePrOptions,
        reason?: GithubCloseReason
      ) => {
        const { repoPath } = ctx.workbench.requireRepo()
        return dashboard.runItemAction(repoPath, kind, number, action, merge, reason)
      }
    )

    // ── Pull-request diff ─────────────────────────────────────────
    // Both run against the repository root: the fetch puts the pull request in
    // the shared object store, so every worktree can read it afterwards.
    route(ctx, 'github:prDiff', async (_e, number: number, baseRefName: string) => {
      const { repoPath } = ctx.workbench.requireRepo()
      const { baseOid, headOid } = await git.fetchPullRequestRefs(repoPath, number, baseRefName)
      const files = await git.changedFilesBetween(repoPath, baseOid, headOid)
      return { baseOid, headOid, files } satisfies GithubPrDiff
    })

    route(ctx, 'github:prBaseFile', (_e, baseOid: string, file: GithubPrFile) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return git.pullRequestBaseFile(repoPath, baseOid, file)
    })

    // Which files this viewer has already read. GitHub's own record, so it is
    // the same tick as the Files tab on github.com.
    route(ctx, 'github:prViewedFiles', (_e, number: number) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.fetchViewedFiles(repoPath, number)
    })

    route(
      ctx,
      'github:setPrFileViewed',
      (_e, pullRequestId: string, path: string, viewed: boolean) => {
        const { repoPath } = ctx.workbench.requireRepo()
        return dashboard.setFileViewed(repoPath, pullRequestId, path, viewed)
      }
    )

    // ── Reviewing ─────────────────────────────────────────────────
    // Comments live on GitHub's own pending review, so one started here can be
    // finished in the browser and the other way round.
    route(ctx, 'github:prReview', (_e, number: number) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.fetchPrReview(repoPath, number)
    })

    route(
      ctx,
      'github:addPrReviewComment',
      (_e, number: number, pullRequestId: string, draft: GithubReviewDraft) => {
        const { repoPath } = ctx.workbench.requireRepo()
        return dashboard.addPrReviewComment(repoPath, number, pullRequestId, draft)
      }
    )

    route(ctx, 'github:addPrReviewReply', (_e, number: number, threadId: string, body: string) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.addPrReviewReply(repoPath, number, threadId, body)
    })

    route(ctx, 'github:setPrThreadResolved', (_e, threadId: string, resolved: boolean) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.setPrThreadResolved(repoPath, threadId, resolved)
    })

    route(ctx, 'github:deletePrReviewComment', (_e, commentId: string) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.deletePrReviewComment(repoPath, commentId)
    })

    route(ctx, 'github:discardPrReview', (_e, number: number) => {
      const { repoPath } = ctx.workbench.requireRepo()
      return dashboard.discardPrReview(repoPath, number)
    })

    route(
      ctx,
      'github:submitPrReview',
      (_e, number: number, pullRequestId: string, event: GithubReviewEvent, body: string) => {
        const { repoPath } = ctx.workbench.requireRepo()
        return dashboard.submitPrReview(repoPath, number, pullRequestId, event, body)
      }
    )

    // Check a pull request out as a worktree of its own, so its whole tree can
    // be read — not only the files it changed — with the editor, the language
    // servers and the agents all pointed at it.
    route(ctx, 'github:checkoutPr', (_e, number: number, baseRefName: string) => {
      return checkoutPullRequest(ctx, number, baseRefName)
    })

    // ── Resolving a pull request's conflicts ──────────────────────

    // Merge the base branch into the pull request's checkout, which is what
    // turns "GitHub says this conflicts" into conflicts on disk that can be
    // resolved. Merging the base in rather than rebasing onto it is what
    // GitHub's own resolver does: the pull request's commits are untouched and
    // nothing has to be force-pushed.
    route(ctx, 'github:resolvePrConflicts', async (_e, number: number, baseRefName: string) => {
      const { repoPath } = ctx.workbench.requireRepo()
      const worktree = await checkoutPullRequest(ctx, number, baseRefName)

      // The checkout may predate the base branch's current tip, and the
      // conflict is against what the base is now.
      await git.fetchPullRequestRefs(repoPath, number, baseRefName)

      if (await git.mergeInProgress(worktree.path)) {
        const files = await git.conflictedFiles(worktree.path)
        return {
          worktreeId: worktree.id,
          merge: { status: 'conflict', files, summary: 'a merge is already open here' }
        }
      }
      if (await git.isDirty(worktree.path)) {
        throw new Error(
          `${worktree.name} has uncommitted changes; commit or revert them before merging ${baseRefName}`
        )
      }

      await ctx.checkpoints.snapshot(worktree.path, 'pre-merge', {
        note: `merge ${baseRefName} → ${worktree.branch}`
      })
      const merge = await git.mergeWorktree(worktree.path, `refs/grove/pr/${number}/base`, {
        mode: 'no-ff'
      })
      return { worktreeId: worktree.id, merge }
    })

    // Where the pull request's checkout stands against the pull request, which
    // is what decides whether resolving, pushing or updating is the thing to
    // offer. Reads the refs as last fetched.
    route(ctx, 'github:prCheckoutState', (_e, number: number) => prCheckoutState(ctx, number))

    // The same, after fetching the pull request's head and base again, so a
    // checkout that has fallen behind shows as behind. Asked for when a pull
    // request is opened, not on every file opened from it.
    route(ctx, 'github:refreshPrCheckout', async (_e, number: number, baseRefName: string) => {
      const { repoPath } = ctx.workbench.requireRepo()
      if (await findPrWorktree(ctx, number)) {
        await git.fetchPullRequestRefs(repoPath, number, baseRefName)
      }
      return prCheckoutState(ctx, number)
    })

    // Bring the checkout up to the pull request — only ever by fast-forward.
    // Anything else would throw work away, so it is refused with the reason.
    route(ctx, 'github:updatePrCheckout', async (_e, number: number, baseRefName: string) => {
      const { repoPath } = ctx.workbench.requireRepo()
      const worktree = await findPrWorktree(ctx, number)
      if (!worktree) throw new Error(`pull request #${number} is not checked out`)
      await git.fetchPullRequestRefs(repoPath, number, baseRefName)
      const before = await prCheckoutState(ctx, number)
      if (before.updateBlockedReason) {
        throw new Error(`${worktree.name} was left as it is: ${before.updateBlockedReason}`)
      }
      if (before.behind > 0) {
        await git.mergeWorktree(worktree.path, `refs/grove/pr/${number}/head`, { mode: 'ff-only' })
      }
      return prCheckoutState(ctx, number)
    })

    // Push the resolved merge back, which is the only thing that makes GitHub
    // stop reporting the conflict. The target is resolved here rather than
    // taken from the caller: it is a repository URL being written to.
    route(ctx, 'github:pushPrBranch', async (_e, number: number) => {
      const { repoPath } = ctx.workbench.requireRepo()
      const worktree = (await ctx.workbench.refreshWorktrees()).find(
        (entry: Worktree) => entry.branch === `pr-${number}`
      )
      if (!worktree) throw new Error(`pull request #${number} is not checked out`)

      const { target, blockedReason } = await dashboard.fetchPushTarget(repoPath, number)
      if (!target) {
        throw new Error(`cannot push to pull request #${number}: ${blockedReason}`)
      }
      if (await git.mergeInProgress(worktree.path)) {
        throw new Error('finish the merge before pushing it')
      }

      const summary = await git.pushHeadTo(worktree.path, target.url, target.branch)
      // The pull request's head is now what was just pushed. Without moving the
      // local mirror of it, the checkout reads as ahead of the pull request for
      // ever and the push keeps being offered.
      await git.updateRef(worktree.path, `refs/grove/pr/${number}/head`, 'HEAD')
      return summary
    })

    // ── Ship-it (the PR of the selected worktree) ─────────────────
    route(ctx, 'github:openPr', (_e, worktreeId: string, options: OpenPrOptions) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return github.openPr(worktree.path, options)
    })

    route(ctx, 'github:mergePr', (_e, worktreeId: string, options: MergePrOptions) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return github.mergePr(worktree.path, options)
    })
  }
}
