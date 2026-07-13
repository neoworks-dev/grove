// GitHub operations via the `gh` CLI. simple-git can't drive PRs, so these
// shell out with the same execAsync pattern used for setup commands. Every
// entry point checks `gh` is installed + authenticated and surfaces a clear
// error instead of failing opaquely.

import { exec } from 'child_process'
import { promisify } from 'util'
import type { OpenPrOptions, MergePrOptions } from '../shared/types'

const execAsync = promisify(exec)

// Run a gh command in a worktree, returning stdout. Throws with gh's stderr on
// failure so callers can show the real reason (auth, no PR, protected branch).
async function runGh(worktreePath: string, args: string[]): Promise<string> {
  await ensureGhReady(worktreePath)
  const command = `gh ${args.join(' ')}`
  try {
    const { stdout } = await execAsync(command, { cwd: worktreePath })
    return stdout.trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr
    const detail = stderr && stderr.trim().length > 0 ? stderr.trim() : (error as Error).message
    throw new Error(`gh command failed (${command}): ${detail}`)
  }
}

// Verify gh is installed and authenticated. Cached failures are not persisted —
// state can change between calls (user runs `gh auth login`).
async function ensureGhReady(worktreePath: string): Promise<void> {
  try {
    await execAsync('gh --version', { cwd: worktreePath })
  } catch {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  try {
    await execAsync('gh auth status', { cwd: worktreePath })
  } catch {
    throw new Error('GitHub CLI is not authenticated — run `gh auth login`')
  }
}

// Shell-quote a value for safe inclusion in a gh command line.
export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Build the `gh pr create` argument list (pure, for testing/reuse).
export function prCreateArgs(options: OpenPrOptions): string[] {
  return [
    'pr',
    'create',
    '--base',
    quote(options.base),
    '--title',
    quote(options.title),
    '--body',
    quote(options.body)
  ]
}

// Build the `gh pr merge` argument list (pure, for testing/reuse).
export function prMergeArgs(options: MergePrOptions): string[] {
  const args = ['pr', 'merge', `--${options.method}`]
  if (options.deleteBranch) args.push('--delete-branch')
  return args
}

// Open a pull request from the worktree's branch. Returns the PR URL.
export async function openPr(worktreePath: string, options: OpenPrOptions): Promise<string> {
  return runGh(worktreePath, prCreateArgs(options))
}

// Merge the worktree's open PR. Returns gh output.
export async function mergePr(worktreePath: string, options: MergePrOptions): Promise<string> {
  return runGh(worktreePath, prMergeArgs(options))
}
