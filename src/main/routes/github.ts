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
  GithubStateFilter,
  MergePrOptions,
  OpenPrOptions,
  Worktree
} from '../../shared/types'

export const githubRoutes = {
  name: 'main/routes/github',
  inject: ['workbench'],

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

    // Check a pull request out as a worktree of its own, so its whole tree can
    // be read — not only the files it changed — with the editor, the language
    // servers and the agents all pointed at it.
    route(ctx, 'github:checkoutPr', async (_e, number: number, baseRefName: string) => {
      const { repoPath, config } = ctx.workbench.requireRepo()

      // Before the fetch: opening a file asks for the checkout every time, and
      // two network round trips in front of every click is what that costs. A
      // worktree that is already there is not re-fetched, so it does not follow
      // the pull request either — see #69.
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
