// Acting on a single commit, from the graph: checking it out, branching from
// it, cherry-picking or reverting it onto the checked-out branch, and resetting
// the branch to it. Like rebasing, a cherry-pick or revert that stops part-way
// is aborted rather than left for a UI Grove does not have.

import { simpleGit, type SimpleGit } from 'simple-git'
import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import { conflictedFiles } from './git'
import type { ResetMode } from '../shared/types'

/** simple-git for a worktree. */
function gitFor(worktreePath: string): SimpleGit {
  return simpleGit({ baseDir: worktreePath })
}

/** Checks a commit out on a detached HEAD. */
export async function checkoutCommit(worktreePath: string, sha: string): Promise<void> {
  await gitFor(worktreePath).raw(['switch', '--detach', sha])
}

/** Creates a branch at a commit, switching to it when asked. */
export async function createBranch(
  worktreePath: string,
  name: string,
  sha: string,
  checkout: boolean
): Promise<void> {
  if (checkout) {
    await gitFor(worktreePath).raw(['switch', '--create', name, sha])
    return
  }
  await gitFor(worktreePath).raw(['branch', name, sha])
}

/** Moves the checked-out branch to a commit. */
export async function reset(worktreePath: string, sha: string, mode: ResetMode): Promise<void> {
  await gitFor(worktreePath).raw(['reset', `--${mode}`, sha])
}

/** Applies a commit's change onto the checked-out branch as a new commit. */
export async function cherryPick(worktreePath: string, sha: string): Promise<string> {
  const args = ['cherry-pick', ...(await mainlineArgs(worktreePath, sha)), sha]
  return runOrAbort(worktreePath, args, 'CHERRY_PICK_HEAD', 'cherry-pick', 'Cherry-picking')
}

/** Adds a commit that undoes a commit's change. */
export async function revert(worktreePath: string, sha: string): Promise<string> {
  const args = ['revert', '--no-edit', ...(await mainlineArgs(worktreePath, sha)), sha]
  return runOrAbort(worktreePath, args, 'REVERT_HEAD', 'revert', 'Reverting')
}

/**
 * `-m 1` for a merge commit, which git will not cherry-pick or revert without
 * being told which parent it is measured against: the branch it was made on.
 */
async function mainlineArgs(worktreePath: string, sha: string): Promise<string[]> {
  const output = await gitFor(worktreePath).raw(['rev-list', '--parents', '-n', '1', sha])
  const parentCount = output.trim().split(' ').length - 1
  if (parentCount > 1) return ['-m', '1']
  return []
}

/**
 * Runs a cherry-pick or revert. If git stops part-way — on a conflict, or
 * because the change is already there — it is aborted, and what stopped it is
 * the error.
 */
async function runOrAbort(
  worktreePath: string,
  args: string[],
  stateFile: string,
  command: string,
  doing: string
): Promise<string> {
  const git = gitFor(worktreePath)
  let reason = ''
  try {
    const output = await git.raw(args)
    if (!(await gitPathExists(worktreePath, stateFile))) return output.trim()
  } catch (err) {
    if (!(await gitPathExists(worktreePath, stateFile))) throw err
    reason = (err as Error).message.trim()
  }
  const files = await conflictedFiles(worktreePath)
  await git.raw([command, '--abort'])
  if (files.length > 0) {
    throw new Error(
      `${doing} stopped on conflicts in ${files.join(', ')}. It was aborted and the branch is unchanged.`
    )
  }
  throw new Error(`${doing} stopped and was aborted; the branch is unchanged. ${reason}`.trim())
}

/** Whether a file exists in the worktree's git directory (`CHERRY_PICK_HEAD`, …). */
async function gitPathExists(worktreePath: string, name: string): Promise<boolean> {
  const output = await gitFor(worktreePath).raw(['rev-parse', '--git-path', name])
  let path = output.trim()
  if (!isAbsolute(path)) path = join(worktreePath, path)
  return existsSync(path)
}
