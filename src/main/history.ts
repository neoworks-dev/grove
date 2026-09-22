// Reading history: the checked-out branch's commits and what each one changed.
// Everything comes from `git log` and `git diff-tree`; nothing is walked or
// diffed in JS.

import { simpleGit } from 'simple-git'
import { parseNameStatusZ } from './git'
import type { BranchCommits, CommitSummary, DiffFile } from '../shared/types'

// Unit and record separators: neither can occur in a subject line or a name,
// so a log formatted with them splits without any quoting.
const FIELD = '\x1f'
const RECORD = '\x1e'
export const LOG_FORMAT = `${['%H', '%h', '%P', '%an', '%ae', '%aI', '%s'].join('%x1f')}%x1e`

/** Parses `git log` output written with LOG_FORMAT. */
export function parseLog(output: string): CommitSummary[] {
  const commits: CommitSummary[] = []
  for (const record of output.split(RECORD)) {
    const fields = record.replace(/^\n/, '').split(FIELD)
    if (fields.length < 7) continue
    const [sha, shortSha, parents, authorName, authorEmail, date, subject] = fields
    commits.push({
      sha,
      shortSha,
      parents: parents.split(' ').filter((parent) => parent.length > 0),
      authorName,
      authorEmail,
      date,
      subject
    })
  }
  return commits
}

/** Runs `git log` with LOG_FORMAT over the given revision arguments. */
export async function log(worktreePath: string, args: string[]): Promise<CommitSummary[]> {
  const output = await simpleGit({ baseDir: worktreePath }).raw([
    'log',
    `--format=${LOG_FORMAT}`,
    ...args
  ])
  return parseLog(output)
}

/**
 * A page of the branch's history, marked with what the upstream lacks and
 * joined by what the upstream has that the branch does not. An unborn branch
 * has no history at all rather than an error.
 */
export async function branchCommits(
  worktreePath: string,
  skip: number,
  limit: number
): Promise<BranchCommits> {
  const empty: BranchCommits = { commits: [], unpushed: [], incoming: [], hasMore: false }
  if (!(await hasCommits(worktreePath))) return empty

  // One extra commit says whether there is another page without a count.
  const page = await log(worktreePath, [`--skip=${skip}`, `--max-count=${limit + 1}`, 'HEAD'])
  const upstream = await hasUpstream(worktreePath)
  const unpushed = await unpushedShas(worktreePath, upstream)
  let incoming: CommitSummary[] = []
  if (upstream) incoming = await log(worktreePath, ['HEAD..@{upstream}'])

  return {
    commits: page.slice(0, limit),
    unpushed,
    incoming,
    hasMore: page.length > limit
  }
}

/**
 * Commits on HEAD that have not been pushed: those the upstream lacks, or with
 * no upstream, those no remote-tracking branch has.
 */
async function unpushedShas(worktreePath: string, upstream: boolean): Promise<string[]> {
  const git = simpleGit({ baseDir: worktreePath })
  let output: string
  if (upstream) output = await git.raw(['rev-list', '@{upstream}..HEAD'])
  else output = await git.raw(['rev-list', 'HEAD', '--not', '--remotes'])
  return output.split('\n').filter((sha) => sha.length > 0)
}

/** Whether HEAD points at a commit — false on a branch with no commits yet. */
function hasCommits(worktreePath: string): Promise<boolean> {
  return resolves(worktreePath, 'HEAD')
}

/** Whether the checked-out branch tracks an upstream. */
function hasUpstream(worktreePath: string): Promise<boolean> {
  return resolves(worktreePath, '@{upstream}')
}

/**
 * Whether a revision names a commit. Read from the output, not the exit code:
 * simple-git only rejects when git also wrote to stderr, and `--quiet` makes
 * sure it does not.
 */
async function resolves(worktreePath: string, revision: string): Promise<boolean> {
  try {
    const out = await simpleGit({ baseDir: worktreePath }).raw([
      'rev-parse',
      '--verify',
      '--quiet',
      `${revision}^{commit}`
    ])
    return out.trim().length > 0
  } catch {
    return false
  }
}

/**
 * The files a commit changed against its first parent, renames detected. A
 * root commit is compared against the empty tree; a merge against the branch
 * it was made on, which is what reading a branch's history means by "changed".
 */
export async function commitFiles(worktreePath: string, sha: string): Promise<DiffFile[]> {
  const git = simpleGit({ baseDir: worktreePath })
  const parents = await git.raw(['rev-list', '--parents', '-n', '1', sha])
  const isRoot = parents.trim().split(' ').length === 1
  const args = ['diff-tree', '-r', '-M', '--name-status', '-z', '--no-commit-id']
  if (isRoot) args.push('--root', sha)
  else args.push(`${sha}^1`, sha)
  return parseNameStatusZ(await git.raw(args), false)
}
