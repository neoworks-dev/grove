// Thin wrapper around the Git CLI (via simple-git). No custom Git behavior —
// every operation shells out to `git`. Diff content is sourced from Git, never
// computed in JS.

import { simpleGit, type SimpleGit } from 'simple-git'
import { basename } from 'path'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type {
  Worktree,
  BranchList,
  DiffFile,
  DiffSides,
  DiffChangeType,
  DiffHunk,
  DiffHunks
} from '../shared/types'

function gitFor(repoPath: string): SimpleGit {
  return simpleGit({ baseDir: repoPath })
}

export async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const result = await gitFor(dirPath).checkIsRepo()
    return result
  } catch {
    return false
  }
}

export async function repoRoot(dirPath: string): Promise<string> {
  const out = await gitFor(dirPath).revparse(['--show-toplevel'])
  return out.trim()
}

export async function currentBranch(repoPath: string): Promise<string> {
  try {
    const out = await gitFor(repoPath).revparse(['--abbrev-ref', 'HEAD'])
    return out.trim()
  } catch {
    // Unborn branch (repo has no commits yet) — rev-parse fails, but the
    // symbolic ref still names the checked-out branch.
    try {
      const ref = await gitFor(repoPath).raw(['symbolic-ref', '--short', 'HEAD'])
      return ref.trim()
    } catch {
      return '(no commits)'
    }
  }
}

// Parse `git worktree list --porcelain` into structured blocks.
export function parseWorktreePorcelain(output: string): Array<{
  path: string
  head: string
  branch: string
  isDetached: boolean
  isBare: boolean
  locked: boolean
}> {
  const blocks: string[] = output.split(/\n\n+/).filter((block) => block.trim().length > 0)
  return blocks.map((block) => {
    const lines = block.split('\n')
    let path = ''
    let head = ''
    let branch = ''
    let isDetached = false
    let isBare = false
    let locked = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim()
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim()
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).trim().replace('refs/heads/', '')
      } else if (line === 'detached') {
        isDetached = true
      } else if (line === 'bare') {
        isBare = true
      } else if (line.startsWith('locked')) {
        locked = true
      }
    }

    return { path, head, branch, isDetached, isBare, locked }
  })
}

export async function isDirty(worktreePath: string): Promise<boolean> {
  const out = await gitFor(worktreePath).raw(['status', '--porcelain'])
  return out.trim().length > 0
}

// List worktrees with dirty status. portSlot is filled in by the caller (ports.ts);
// git knows nothing about ports, so it defaults to -1 here.
export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const out = await gitFor(repoPath).raw(['worktree', 'list', '--porcelain'])
  const parsed = parseWorktreePorcelain(out)

  const worktrees: Worktree[] = []
  for (const entry of parsed) {
    if (entry.isBare) continue
    const dirty = await isDirty(entry.path)
    const branch = entry.branch || (entry.isDetached ? entry.head.slice(0, 8) : '(unknown)')
    worktrees.push({
      id: entry.path,
      name: basename(entry.path),
      path: entry.path,
      branch,
      isMain: entry.path === (await repoRoot(repoPath)),
      isDetached: entry.isDetached,
      locked: entry.locked,
      dirty,
      portSlot: -1
    })
  }
  return worktrees
}

export async function listBranches(repoPath: string): Promise<BranchList> {
  const summary = await gitFor(repoPath).branchLocal()
  return {
    current: summary.current,
    all: summary.all,
    local: summary.all
  }
}

// Create a worktree, optionally on a new branch.
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  options: { newBranch?: string; baseBranch?: string; checkoutBranch?: string }
): Promise<void> {
  const args = ['worktree', 'add']
  if (options.newBranch) {
    args.push('-b', options.newBranch, worktreePath, options.baseBranch || 'HEAD')
  } else if (options.checkoutBranch) {
    args.push(worktreePath, options.checkoutBranch)
  } else {
    args.push(worktreePath, options.baseBranch || 'HEAD')
  }
  await gitFor(repoPath).raw(args)
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean
): Promise<void> {
  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')
  await gitFor(repoPath).raw(args)
}

// Delete a local branch. Uses -d (safe, refuses unmerged) unless force.
export async function deleteBranch(
  repoPath: string,
  branch: string,
  force: boolean
): Promise<void> {
  await gitFor(repoPath).raw(['branch', force ? '-D' : '-d', branch])
}

// ── Ship-it chain: stage → commit → push → merge ────────────────

// Stage specific paths (git add). Empty list stages nothing.
export async function stage(worktreePath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await gitFor(worktreePath).raw(['add', '--', ...paths])
}

// Unstage specific paths, keeping working-tree changes (git restore --staged).
export async function unstage(worktreePath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await gitFor(worktreePath).raw(['restore', '--staged', '--', ...paths])
}

// Commit staged changes with a message. Returns git's summary output.
export async function commit(worktreePath: string, message: string): Promise<string> {
  const out = await gitFor(worktreePath).raw(['commit', '-m', message])
  return out.trim()
}

// Push the current branch, setting upstream to origin. Returns git output.
export async function push(worktreePath: string): Promise<string> {
  const out = await gitFor(worktreePath).raw(['push', '-u', 'origin', 'HEAD'])
  return out.trim()
}

// Merge a feature branch into the base branch locally. The merge runs in the
// main worktree (mainWorktreePath) because a branch checked out in another
// worktree cannot be checked out here; the base branch is expected to live in
// the main worktree. Refuses to run if the main worktree is dirty.
export async function mergeToBase(
  mainWorktreePath: string,
  branch: string,
  baseBranch: string
): Promise<string> {
  const dirty = await isDirty(mainWorktreePath)
  if (dirty) {
    throw new Error(
      `main worktree at ${mainWorktreePath} has uncommitted changes; cannot merge into ${baseBranch}`
    )
  }
  const git = gitFor(mainWorktreePath)
  await git.raw(['checkout', baseBranch])
  const out = await git.raw(['merge', '--no-ff', branch])
  return out.trim()
}

// ── Diff (all content sourced from Git) ─────────────────────────

function mapStatusCode(code: string): DiffChangeType {
  if (code.startsWith('A')) return 'added'
  if (code.startsWith('D')) return 'deleted'
  if (code.startsWith('R')) return 'renamed'
  if (code === '??') return 'untracked'
  return 'modified'
}

// Changed files vs HEAD: staged (--staged) and unstaged, plus untracked.
export async function changedFiles(worktreePath: string): Promise<DiffFile[]> {
  const git = gitFor(worktreePath)
  const files: DiffFile[] = []

  const staged = await git.raw(['diff', '--staged', '--name-status', '-z'])
  parseNameStatusZ(staged, true).forEach((file) => files.push(file))

  const unstaged = await git.raw(['diff', '--name-status', '-z'])
  parseNameStatusZ(unstaged, false).forEach((file) => files.push(file))

  const untracked = await git.raw(['ls-files', '--others', '--exclude-standard', '-z'])
  untracked
    .split('\0')
    .filter((path) => path.length > 0)
    .forEach((path) => files.push({ path, changeType: 'untracked', staged: false }))

  return files
}

// Parse NUL-delimited `--name-status -z` output. Renames consume two path fields.
export function parseNameStatusZ(output: string, staged: boolean): DiffFile[] {
  const parts = output.split('\0').filter((part) => part.length > 0)
  const files: DiffFile[] = []
  let index = 0
  while (index < parts.length) {
    const code = parts[index]
    index += 1
    const changeType = mapStatusCode(code)
    if (changeType === 'renamed') {
      const oldPath = parts[index]
      const newPath = parts[index + 1]
      index += 2
      files.push({ path: newPath, oldPath, changeType, staged })
    } else {
      const path = parts[index]
      index += 1
      files.push({ path, changeType, staged })
    }
  }
  return files
}

// Content of a file at a ref (e.g. HEAD). Returns empty string if absent.
export async function fileAtRef(
  worktreePath: string,
  ref: string,
  relPath: string
): Promise<string> {
  try {
    return await gitFor(worktreePath).raw(['show', `${ref}:${relPath}`])
  } catch {
    return ''
  }
}

async function workingTreeFile(worktreePath: string, relPath: string): Promise<string> {
  try {
    return await readFile(join(worktreePath, relPath), 'utf8')
  } catch {
    return ''
  }
}

// Build the two sides of a diff for the DiffEditor. Original comes from Git
// (HEAD or index); modified comes from working tree or index. No JS diffing.
export async function diffSides(
  worktreePath: string,
  file: DiffFile
): Promise<DiffSides> {
  const language = detectLanguage(file.path)

  if (file.changeType === 'untracked') {
    return {
      path: file.path,
      original: '',
      modified: await workingTreeFile(worktreePath, file.path),
      language
    }
  }

  if (file.staged) {
    const original = await fileAtRef(worktreePath, 'HEAD', file.oldPath || file.path)
    const modified = await gitFor(worktreePath)
      .raw(['show', `:${file.path}`])
      .catch(() => '')
    return { path: file.path, original, modified, language }
  }

  const original = await fileAtRef(worktreePath, 'HEAD', file.oldPath || file.path)
  const modified = await workingTreeFile(worktreePath, file.path)
  return { path: file.path, original, modified, language }
}

// Changed line ranges for a file, from `git diff` hunk headers. Plain `git
// diff` exits 0 even with differences (no --exit-code), so raw() resolves
// normally. Untracked files have no tracked diff — every line is new, which
// the renderer infers from the empty original side.
export async function diffHunks(worktreePath: string, file: DiffFile): Promise<DiffHunks> {
  if (file.changeType === 'untracked') return { path: file.path, hunks: [] }
  const args = ['diff', '-U0', '--no-color']
  if (file.staged) args.push('--cached')
  args.push('--', file.path)
  const output = await gitFor(worktreePath)
    .raw(args)
    .catch(() => '')
  return { path: file.path, hunks: parseHunks(output) }
}

// Parse the `@@ -a,b +c,d @@` headers of a unified diff. A missing count means
// 1 (git omits `,n` when n is 1).
export function parseHunks(diff: string): DiffHunk[] {
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  const hunks: DiffHunk[] = []
  let match = header.exec(diff)
  while (match !== null) {
    hunks.push({
      originalStart: Number(match[1]),
      originalCount: match[2] === undefined ? 1 : Number(match[2]),
      modifiedStart: Number(match[3]),
      modifiedCount: match[4] === undefined ? 1 : Number(match[4])
    })
    match = header.exec(diff)
  }
  return hunks
}

export function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    svelte: 'html',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'shell',
    toml: 'ini'
  }
  return map[ext] || 'plaintext'
}
