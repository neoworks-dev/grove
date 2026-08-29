// Everything git: branches, diffs, the inline edit review, and the ship-it chain.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as git from '../git'
import * as github from '../github'
import * as inlineDiff from '../inlineDiff'
import * as worktrees from '../worktrees'
import type { DiffFile, InlineHunk, OpenPrOptions, MergePrOptions } from '../../shared/types'

export const gitRoutes = {
  name: 'main/routes/git',
  inject: ['workbench', 'checkpoints', 'supervisor'],

  apply(ctx: Context): void {
    // ── Git (branches + diff) ─────────────────────────────────────
    route(ctx, 'git:branches', () => {
      const { repoPath } = ctx.workbench.requireRepo()
      return git.listBranches(repoPath)
    })

    route(ctx, 'git:changedFiles', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.changedFiles(worktree.path)
    })

    route(ctx, 'git:diffSides', (_e, worktreeId: string, file: DiffFile) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.diffSides(worktree.path, file)
    })

    route(ctx, 'git:diffHunks', (_e, worktreeId: string, file: DiffFile) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.diffHunks(worktree.path, file)
    })

    route(ctx, 'git:diffStats', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.diffStats(worktree.path)
    })

    // ── Inline agent edit (per-hunk accept/reject) ──────────────────
    route(
      ctx,
      'git:beginInlineReview',
      async (_e, worktreeId: string, relPath: string, snapshot: string) => {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        const hunks = await inlineDiff.diffSnapshot(worktree.path, relPath, snapshot)
        const ranges = inlineDiff.rebuildWithAccepted(
          snapshot,
          hunks,
          hunks.map(() => true)
        ).ranges
        return { hunks, ranges }
      }
    )

    route(
      ctx,
      'git:applyInlineReview',
      (
        _e,
        worktreeId: string,
        relPath: string,
        snapshot: string,
        hunks: InlineHunk[],
        applied: boolean[]
      ) => {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        return inlineDiff.applyInlineReview(worktree.path, relPath, snapshot, hunks, applied)
      }
    )

    // Unified diff between two in-memory file versions, for previewing a pending
    // Write/Edit inline in the permission card.
    route(ctx, 'git:diffText', (_e, worktreeId: string, before: string, after: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return inlineDiff.diffStrings(worktree.path, before, after)
    })

    // ── Git ship-it chain (stage → commit → push → merge → archive) ──
    route(ctx, 'git:stage', (_e, worktreeId: string, paths: string[]) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.stage(worktree.path, paths)
    })

    route(ctx, 'git:unstage', (_e, worktreeId: string, paths: string[]) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.unstage(worktree.path, paths)
    })

    route(ctx, 'git:commit', (_e, worktreeId: string, message: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.commit(worktree.path, message)
    })

    route(ctx, 'git:push', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.push(worktree.path)
    })

    // Local merge runs in the main worktree (repoPath), merging the feature
    // worktree's branch into baseBranch.
    route(ctx, 'git:mergeLocal', (_e, worktreeId: string, baseBranch: string) => {
      const { repoPath } = ctx.workbench.requireRepo()
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.mergeToBase(repoPath, worktree.branch, baseBranch)
    })

    // ── Worktree-into-worktree merge ────────────────────────────────
    route(
      ctx,
      'git:mergePreview',
      async (_e, targetWorktreeId: string, sourceWorktreeId: string) => {
        const target = ctx.workbench.findWorktree(targetWorktreeId)
        const source = ctx.workbench.findWorktree(sourceWorktreeId)
        const preview = await git.mergePreview(target.path, source.branch)
        return { ...preview, sourceDirty: await git.isDirty(source.path) }
      }
    )

    route(
      ctx,
      'git:mergeWorktree',
      async (
        _e,
        targetWorktreeId: string,
        sourceWorktreeId: string,
        opts: { mode: import('../../shared/types').MergeMode; message?: string }
      ) => {
        const target = ctx.workbench.findWorktree(targetWorktreeId)
        const source = ctx.workbench.findWorktree(sourceWorktreeId)
        if (target.isDetached) {
          throw new Error(
            `target worktree "${target.name}" is on a detached HEAD; cannot merge into it`
          )
        }
        if (await git.isDirty(target.path)) {
          throw new Error(
            `target worktree "${target.name}" has uncommitted changes; commit or revert them before merging`
          )
        }
        // Snapshot the target before the merge so a bad result is one restore away.
        await ctx.checkpoints.snapshot(target.path, 'pre-merge', {
          note: `merge ${source.branch} → ${target.branch}`
        })
        return git.mergeWorktree(target.path, source.branch, opts)
      }
    )

    route(ctx, 'git:mergeAbort', (_e, targetWorktreeId: string) => {
      const target = ctx.workbench.findWorktree(targetWorktreeId)
      return git.abortMerge(target.path)
    })

    route(ctx, 'git:mergeContinue', (_e, targetWorktreeId: string) => {
      const target = ctx.workbench.findWorktree(targetWorktreeId)
      return git.continueMerge(target.path)
    })

    route(ctx, 'git:mergeConflicts', (_e, targetWorktreeId: string) => {
      const target = ctx.workbench.findWorktree(targetWorktreeId)
      return git.conflictedFiles(target.path)
    })

    route(ctx, 'github:openPr', (_e, worktreeId: string, options: OpenPrOptions) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return github.openPr(worktree.path, options)
    })

    route(ctx, 'github:mergePr', (_e, worktreeId: string, options: MergePrOptions) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return github.mergePr(worktree.path, options)
    })

    route(
      ctx,
      'worktrees:archive',
      async (_e, worktreeId: string, options: { deleteBranch: boolean; force: boolean }) => {
        const { repoPath } = ctx.workbench.requireRepo()
        const worktree = ctx.workbench.findWorktree(worktreeId)
        await ctx.supervisor.stopAllForWorktree(worktreeId)
        await worktrees.archiveWorktree(repoPath, worktree.path, {
          branch: worktree.branch,
          deleteBranch: options.deleteBranch,
          force: options.force
        })
        return ctx.workbench.refreshWorktrees()
      }
    )
  }
}
