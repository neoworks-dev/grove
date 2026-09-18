// GitHub: the issue / pull-request dashboard, and the worktree ship-it calls
// (`gh pr create` / `gh pr merge`) that belong to the same CLI.
//
// Dashboard calls run against the repository root — gh resolves the repository
// from its remotes, and every worktree shares them.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as github from '../github'
import * as dashboard from '../githubDashboard'
import type {
  GithubIssueDraft,
  GithubItemAction,
  GithubItemCommand,
  GithubLabelChange,
  GithubCloseReason,
  GithubAssigneeChange,
  GithubItemKind,
  GithubStateFilter,
  MergePrOptions,
  OpenPrOptions
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
