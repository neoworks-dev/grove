// Everything git: branches, diffs, the inline edit review, and the local half of
// the ship-it chain. The GitHub half lives in `routes/github.ts`.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as git from '../git'
import * as commitOps from '../commitOps'
import * as conflicts from '../conflicts'
import * as history from '../history'
import * as refs from '../refs'
import * as hunkStaging from '../hunkStaging'
import * as inlineDiff from '../inlineDiff'
import * as worktrees from '../worktrees'
import type {
  ArchiveOptions,
  ConflictChoice,
  DiffFile,
  InlineHunk,
  ResetMode
} from '../../shared/types'

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

    route(ctx, 'git:stageHunk', (_e, worktreeId: string, file: DiffFile, hunkIndex: number) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return hunkStaging.stageHunk(worktree.path, file, hunkIndex)
    })

    route(ctx, 'git:unstageHunk', (_e, worktreeId: string, file: DiffFile, hunkIndex: number) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return hunkStaging.unstageHunk(worktree.path, file, hunkIndex)
    })

    route(ctx, 'git:pull', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.pull(worktree.path)
    })

    route(ctx, 'git:fetch', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.fetch(worktree.path)
    })

    // ── History ─────────────────────────────────────────────────────
    route(ctx, 'git:branchCommits', (_e, worktreeId: string, skip: number, limit: number) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return history.branchCommits(worktree.path, skip, limit)
    })

    route(ctx, 'git:commitFiles', (_e, worktreeId: string, sha: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return history.commitFiles(worktree.path, sha)
    })

    route(ctx, 'git:graph', (_e, worktreeId: string, skip: number, limit: number) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return history.graphCommits(worktree.path, skip, limit)
    })

    route(ctx, 'git:commitMessage', (_e, worktreeId: string, sha: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return history.commitMessage(worktree.path, sha)
    })

    route(
      ctx,
      'git:searchCommits',
      (_e, worktreeId: string, query: string, skip: number, limit: number) => {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        return history.searchCommits(worktree.path, query, skip, limit)
      }
    )

    route(
      ctx,
      'git:fileAtRevision',
      (_e, worktreeId: string, revision: string, relPath: string) => {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        return git.fileAtRef(worktree.path, revision, relPath)
      }
    )

    route(ctx, 'git:branchStatus', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.branchStatus(worktree.path)
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

    route(ctx, 'git:mergeState', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return conflicts.mergeState(worktree.path)
    })

    route(
      ctx,
      'git:resolveConflict',
      (_e, worktreeId: string, relPath: string, hunkIndex: number, choice: ConflictChoice) => {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        return conflicts.resolveConflictHunk(worktree.path, relPath, hunkIndex, choice)
      }
    )

    // ── Branches, tags, stashes, compare ────────────────────────────
    route(ctx, 'git:refs', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return refs.listRefs(worktree.path)
    })

    route(ctx, 'git:stashes', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return refs.listStashes(worktree.path)
    })

    // Checking out another branch changes what the worktree is on, so the
    // worktree list is refreshed before the renderer reads it again.
    route(ctx, 'git:checkout', async (_e, worktreeId: string, branch: string, remote: boolean) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await refs.checkout(worktree.path, branch, remote)
      return ctx.workbench.refreshWorktrees()
    })

    route(ctx, 'git:mergeRef', async (_e, worktreeId: string, ref: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await requireClean(worktree.path, worktree.name, 'merging')
      await ctx.checkpoints.snapshot(worktree.path, 'pre-merge', {
        note: `merge ${ref} → ${worktree.branch}`
      })
      return git.mergeWorktree(worktree.path, ref, { mode: 'ff' })
    })

    route(ctx, 'git:rebaseOnto', async (_e, worktreeId: string, onto: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await requireClean(worktree.path, worktree.name, 'rebasing')
      await ctx.checkpoints.snapshot(worktree.path, 'pre-rebase', {
        note: `rebase ${worktree.branch} onto ${onto}`
      })
      return refs.rebaseOnto(worktree.path, onto)
    })

    // ── Single commits ──────────────────────────────────────────────
    route(ctx, 'git:checkoutCommit', async (_e, worktreeId: string, sha: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await commitOps.checkoutCommit(worktree.path, sha)
      return ctx.workbench.refreshWorktrees()
    })

    route(
      ctx,
      'git:createBranch',
      async (_e, worktreeId: string, name: string, sha: string, checkout: boolean) => {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        await commitOps.createBranch(worktree.path, name, sha, checkout)
        return ctx.workbench.refreshWorktrees()
      }
    )

    route(ctx, 'git:cherryPick', async (_e, worktreeId: string, sha: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await requireClean(worktree.path, worktree.name, 'cherry-picking')
      return commitOps.cherryPick(worktree.path, sha)
    })

    route(ctx, 'git:revert', async (_e, worktreeId: string, sha: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await requireClean(worktree.path, worktree.name, 'reverting')
      return commitOps.revert(worktree.path, sha)
    })

    // A reset can throw commits and uncommitted work away, so it is preceded by
    // a checkpoint the way a merge or rebase is.
    route(ctx, 'git:reset', async (_e, worktreeId: string, sha: string, mode: ResetMode) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await ctx.checkpoints.snapshot(worktree.path, 'pre-reset', {
        note: `reset --${mode} ${worktree.branch} to ${sha.slice(0, 7)}`
      })
      await commitOps.reset(worktree.path, sha, mode)
      return ctx.workbench.refreshWorktrees()
    })

    route(ctx, 'git:deleteBranch', (_e, worktreeId: string, branch: string, force: boolean) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return git.deleteBranch(worktree.path, branch, force)
    })

    route(ctx, 'git:stashPush', (_e, worktreeId: string, message: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return refs.stashPush(worktree.path, message)
    })

    route(ctx, 'git:stashApply', (_e, worktreeId: string, ref: string, pop: boolean) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return refs.stashApply(worktree.path, ref, pop)
    })

    route(ctx, 'git:stashDrop', (_e, worktreeId: string, ref: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return refs.stashDrop(worktree.path, ref)
    })

    route(ctx, 'git:compare', (_e, worktreeId: string, base: string, head: string | null) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return refs.compareRefs(worktree.path, base, head)
    })

    route(ctx, 'worktrees:archive', async (_e, worktreeId: string, options: ArchiveOptions) => {
      const { repoPath } = ctx.workbench.requireRepo()
      const worktree = ctx.workbench.findWorktree(worktreeId)
      await ctx.supervisor.stopAllForWorktree(worktreeId)
      await worktrees.archiveWorktree(repoPath, worktree.path, {
        branch: worktree.branch,
        deleteBranch: options.deleteBranch,
        force: options.force,
        forceBranch: options.forceBranch
      })
      return ctx.workbench.refreshWorktrees()
    })
  }
}

/** Refuses an operation that rewrites the checked-out branch while it has uncommitted changes. */
async function requireClean(worktreePath: string, name: string, doing: string): Promise<void> {
  if (!(await git.isDirty(worktreePath))) return
  throw new Error(
    `worktree "${name}" has uncommitted changes; commit or stash them before ${doing}`
  )
}
