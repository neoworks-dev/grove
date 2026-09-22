// What a branch, tag or stash row can do, shared by the rows and their menus.
// Every action reports failure through the error bar and success as a toast,
// and anything that throws work away asks first.

import { store, refreshWorktrees } from '../../../lib/store.svelte'
import { dialogs } from '../../../lib/dialogs.svelte'
import type { BranchRef, StashEntry } from '../../../../../shared/types'

/** Runs a git action, surfacing its error; true when it succeeded. */
async function attempt(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action()
    return true
  } catch (err) {
    store.setError((err as Error).message)
    return false
  }
}

/** Checks a branch out in the worktree, then re-reads what every worktree is on. */
export async function checkoutBranch(worktreeId: string, branch: BranchRef): Promise<boolean> {
  const remote = branch.remote !== null
  const done = await attempt(() => window.workbench.git.checkout(worktreeId, branch.name, remote))
  if (done) await refreshWorktrees()
  return done
}

/** Switches the view to the worktree a branch is checked out in, if Grove knows it. */
export function openBranchWorktree(branch: BranchRef): void {
  const worktree = store.worktrees.find((candidate) => candidate.path === branch.worktreePath)
  if (worktree) store.selectedWorktreeId = worktree.id
}

/** Merges a ref into the checked-out branch; conflicts land in the view's conflicts section. */
export async function mergeIntoCurrent(worktreeId: string, ref: string): Promise<boolean> {
  try {
    const result = await window.workbench.git.mergeRef(worktreeId, ref)
    if (result.status === 'up-to-date') notify(`Already up to date with ${ref}.`)
    if (result.status === 'merged') notify(`Merged ${ref}.`)
    if (result.status === 'conflict') {
      notify(`Merging ${ref} stopped on conflicts in ${result.files.length} file(s).`)
    }
    return true
  } catch (err) {
    store.setError((err as Error).message)
    return false
  }
}

/** Rebases the checked-out branch onto a ref. */
export async function rebaseCurrentOnto(
  worktreeId: string,
  currentBranch: string,
  onto: string
): Promise<boolean> {
  const choice = await dialogs.confirm({
    title: `Rebase ${currentBranch} onto ${onto}?`,
    body: 'This rewrites the branch’s commits. A checkpoint is taken first, and a rebase that hits conflicts is aborted.',
    actions: [
      { id: 'rebase', label: 'Rebase', kind: 'primary' },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (choice !== 'rebase') return false
  const done = await attempt(() => window.workbench.git.rebaseOnto(worktreeId, onto))
  if (done) notify(`Rebased ${currentBranch} onto ${onto}.`)
  return done
}

/**
 * Deletes a local branch. A branch git will not delete safely — its commits
 * are merged nowhere — gets a second, louder question before it is forced.
 */
export async function deleteBranch(worktreeId: string, branch: BranchRef): Promise<boolean> {
  const choice = await dialogs.confirm({
    title: `Delete branch ${branch.name}?`,
    body: 'Only the local branch is deleted.',
    actions: [
      { id: 'delete', label: 'Delete', kind: 'danger' },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (choice !== 'delete') return false
  try {
    await window.workbench.git.deleteBranch(worktreeId, branch.name, false)
    return true
  } catch (err) {
    const message = (err as Error).message
    if (!message.includes('not fully merged')) {
      store.setError(message)
      return false
    }
    return forceDeleteBranch(worktreeId, branch)
  }
}

/** Asks again for a branch whose commits would be lost, then deletes it anyway. */
async function forceDeleteBranch(worktreeId: string, branch: BranchRef): Promise<boolean> {
  const choice = await dialogs.confirm({
    title: `${branch.name} is not fully merged`,
    body: 'Its commits are on no other branch. Deleting it anyway loses them.',
    actions: [
      { id: 'force', label: 'Delete anyway', kind: 'danger' },
      { id: 'cancel', label: 'Keep it' }
    ]
  })
  if (choice !== 'force') return false
  return attempt(() => window.workbench.git.deleteBranch(worktreeId, branch.name, true))
}

/** Applies a stash, keeping it or (`pop`) dropping it once applied. */
export function applyStash(worktreeId: string, stash: StashEntry, pop: boolean): Promise<boolean> {
  return attempt(() => window.workbench.git.stashApply(worktreeId, stash.ref, pop))
}

/** Drops a stash after asking. */
export async function dropStash(worktreeId: string, stash: StashEntry): Promise<boolean> {
  const choice = await dialogs.confirm({
    title: `Drop ${stash.ref}?`,
    body: stash.commit.subject,
    actions: [
      { id: 'drop', label: 'Drop', kind: 'danger' },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (choice !== 'drop') return false
  return attempt(() => window.workbench.git.stashDrop(worktreeId, stash.ref))
}

/** Stashes every uncommitted change, untracked files included. */
export function stashChanges(worktreeId: string): Promise<boolean> {
  return attempt(() => window.workbench.git.stashPush(worktreeId, ''))
}

/** Copies a ref's name. */
export function copyText(text: string): void {
  void navigator.clipboard.writeText(text)
}

/** A short confirmation toast. */
function notify(message: string): void {
  dialogs.notify({ level: 'info', message })
}
