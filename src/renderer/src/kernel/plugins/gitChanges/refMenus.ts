// The menus a branch or tag offers, shared by their rows in the source-control
// view and their labels in the commit graph.

import type { MenuItem } from '../../../components/ContextMenu.svelte'
import { compareRefs } from './compareTarget.svelte'
import {
  checkoutBranch,
  copyText,
  deleteBranch,
  mergeIntoCurrent,
  openBranchWorktree,
  rebaseCurrentOnto
} from './refActions'
import type { BranchRef, TagRef } from '../../../../../shared/types'

// Where the menu is opened: which worktree acts, what it has checked out, and
// what to do once an action changed something.
export interface RefMenuContext {
  worktreeId: string
  worktreePath: string
  currentBranch: string
  onChanged: () => void
}

/** Runs an action and reloads when it changed anything. */
async function run(context: RefMenuContext, action: () => Promise<boolean>): Promise<void> {
  if (await action()) context.onChanged()
}

/** Whether a branch is checked out in a worktree other than the one acting. */
export function checkedOutElsewhere(branch: BranchRef, worktreePath: string): boolean {
  return branch.worktreePath !== null && branch.worktreePath !== worktreePath && !branch.current
}

/** What checking a branch out does from here. */
export function checkoutLabel(branch: BranchRef, worktreePath: string): string {
  if (checkedOutElsewhere(branch, worktreePath)) return 'Open its worktree'
  return 'Checkout'
}

/** Checks a branch out here, or goes to the worktree that has it. */
export function checkoutOrOpen(context: RefMenuContext, branch: BranchRef): void {
  if (checkedOutElsewhere(branch, context.worktreePath)) {
    openBranchWorktree(branch)
    return
  }
  void run(context, () => checkoutBranch(context.worktreeId, branch))
}

/** Everything a branch offers, in the order it offers it. */
export function branchMenu(context: RefMenuContext, branch: BranchRef): MenuItem[] {
  const { worktreeId, worktreePath, currentBranch } = context
  const items: MenuItem[] = []
  if (!branch.current) {
    items.push({
      label: checkoutLabel(branch, worktreePath),
      action: () => checkoutOrOpen(context, branch)
    })
    items.push({
      label: `Merge into ${currentBranch}`,
      action: () => void run(context, () => mergeIntoCurrent(worktreeId, branch.name))
    })
    items.push({
      label: `Rebase ${currentBranch} onto ${branch.name}`,
      action: () =>
        void run(context, () => rebaseCurrentOnto(worktreeId, currentBranch, branch.name))
    })
    items.push({ divider: true })
    items.push({ label: 'Compare with HEAD', action: () => compareRefs(branch.name, 'HEAD') })
  }
  items.push({ label: 'Compare with working tree', action: () => compareRefs(branch.name, null) })
  items.push({ divider: true })
  items.push({ label: 'Copy name', action: () => copyText(branch.name) })
  if (branch.remote === null && !branch.current && branch.worktreePath === null) {
    items.push({ divider: true })
    items.push({
      label: 'Delete branch',
      danger: true,
      action: () => void run(context, () => deleteBranch(worktreeId, branch))
    })
  }
  return items
}

/** Everything a tag offers. Not checking it out, which would detach HEAD. */
export function tagMenu(context: RefMenuContext, tag: TagRef): MenuItem[] {
  return [
    { label: 'Compare with HEAD', action: () => compareRefs(tag.name, 'HEAD') },
    { label: 'Compare with working tree', action: () => compareRefs(tag.name, null) },
    { divider: true },
    {
      label: `Merge into ${context.currentBranch}`,
      action: () => void run(context, () => mergeIntoCurrent(context.worktreeId, tag.name))
    },
    { divider: true },
    { label: 'Copy name', action: () => copyText(tag.name) }
  ]
}
