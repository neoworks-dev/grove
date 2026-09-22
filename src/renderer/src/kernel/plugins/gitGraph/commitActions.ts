// What the graph can do to a single commit. Anything that moves the checked-out
// branch or throws work away asks first; every action reports failure through
// the error bar and success as a toast, like the branch actions it sits beside.

import { dialogs } from '../../../lib/dialogs.svelte'
import { refreshWorktrees } from '../../../lib/store.svelte'
import { attempt, notify } from '../gitChanges/refActions'
import type { CommitSummary, ResetMode } from '../../../../../shared/types'

/** Checks the commit out on a detached HEAD. */
export async function checkoutCommit(worktreeId: string, commit: CommitSummary): Promise<boolean> {
  const choice = await dialogs.confirm({
    title: `Check out ${commit.shortSha}?`,
    body: 'HEAD will be detached: new commits made there belong to no branch until you create one.',
    actions: [
      { id: 'checkout', label: 'Check out', kind: 'primary' },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (choice !== 'checkout') return false
  const done = await attempt(() => window.workbench.git.checkoutCommit(worktreeId, commit.sha))
  if (done) await refreshWorktrees()
  return done
}

/** Creates a branch at the commit, switching to it when asked. */
export async function createBranchAt(
  worktreeId: string,
  commit: CommitSummary,
  name: string,
  checkout: boolean
): Promise<boolean> {
  const done = await attempt(() =>
    window.workbench.git.createBranch(worktreeId, name, commit.sha, checkout)
  )
  if (!done) return false
  await refreshWorktrees()
  notify(`Created ${name} at ${commit.shortSha}.`)
  return true
}

/** Applies the commit's change onto the checked-out branch. */
export async function cherryPickCommit(
  worktreeId: string,
  commit: CommitSummary
): Promise<boolean> {
  const done = await attempt(() => window.workbench.git.cherryPick(worktreeId, commit.sha))
  if (done) notify(`Cherry-picked ${commit.shortSha}.`)
  return done
}

/** Commits the inverse of the commit's change. */
export async function revertCommit(worktreeId: string, commit: CommitSummary): Promise<boolean> {
  const choice = await dialogs.confirm({
    title: `Revert ${commit.shortSha}?`,
    body: `A new commit undoing “${commit.subject}” is added to the checked-out branch.`,
    actions: [
      { id: 'revert', label: 'Revert', kind: 'primary' },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (choice !== 'revert') return false
  const done = await attempt(() => window.workbench.git.revert(worktreeId, commit.sha))
  if (done) notify(`Reverted ${commit.shortSha}.`)
  return done
}

// What each reset keeps, for its confirmation.
const RESET_EFFECT: Record<ResetMode, string> = {
  soft: 'The commits after it are undone, their changes left staged.',
  mixed: 'The commits after it are undone, their changes left in the working tree, unstaged.',
  hard: 'The commits after it and every uncommitted change are thrown away.'
}

/** Moves the checked-out branch to the commit. A checkpoint is taken first. */
export async function resetToCommit(
  worktreeId: string,
  currentBranch: string,
  commit: CommitSummary,
  mode: ResetMode
): Promise<boolean> {
  let kind: 'primary' | 'danger' = 'primary'
  if (mode === 'hard') kind = 'danger'
  const choice = await dialogs.confirm({
    title: `Reset ${currentBranch} to ${commit.shortSha} (${mode})?`,
    body: `${RESET_EFFECT[mode]} A checkpoint is taken first.`,
    actions: [
      { id: 'reset', label: 'Reset', kind },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (choice !== 'reset') return false
  const done = await attempt(() => window.workbench.git.reset(worktreeId, commit.sha, mode))
  if (done) await refreshWorktrees()
  return done
}
