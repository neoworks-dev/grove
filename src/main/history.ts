// Reading history: the checked-out branch's commits, the whole repository's
// for the graph, searches through it, and what each commit changed. Everything
// comes from `git log` and `git diff-tree`; nothing is walked or diffed in JS.

import { simpleGit } from 'simple-git'
import { parseNameStatusZ } from './git'
import type {
  BranchCommits,
  CommitSearchPage,
  CommitSummary,
  DiffFile,
  GraphPage
} from '../shared/types'

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

// Every branch, remote branch and tag, and HEAD in case it is detached. Not
// `--all`, which would also walk the stash and Grove's checkpoint refs.
const ALL_HISTORY = ['--branches', '--remotes', '--tags', 'HEAD']

/**
 * A page of the whole repository's history for the commit graph, children
 * always before their parents so lanes can be laid out top to bottom.
 */
export async function graphCommits(
  worktreePath: string,
  skip: number,
  limit: number
): Promise<GraphPage> {
  if (!(await hasCommits(worktreePath))) return { commits: [], head: null, hasMore: false }
  const page = await log(worktreePath, [
    '--date-order',
    `--skip=${skip}`,
    `--max-count=${limit + 1}`,
    ...ALL_HISTORY
  ])
  const head = await simpleGit({ baseDir: worktreePath }).raw(['rev-parse', 'HEAD'])
  return { commits: page.slice(0, limit), head: head.trim(), hasMore: page.length > limit }
}

/** A commit's whole message: subject, blank line and body. */
export async function commitMessage(worktreePath: string, sha: string): Promise<string> {
  const output = await simpleGit({ baseDir: worktreePath }).raw([
    'log',
    '-1',
    '--format=%B',
    sha
  ])
  return output.trimEnd()
}

// ── Search ───────────────────────────────────────────────────────

// What a search query asks for, one list per kind of term.
export interface CommitQuery {
  messages: string[]
  authors: string[]
  shas: string[]
  files: string[]
  // A regex for lines a commit added or removed (`git log -G`). Git takes one.
  change: string | null
}

// GitLens's search operators, short and long form.
const OPERATORS: Record<string, keyof CommitQuery> = {
  '=:': 'messages',
  'message:': 'messages',
  '@:': 'authors',
  'author:': 'authors',
  '#:': 'shas',
  'commit:': 'shas',
  '?:': 'files',
  'file:': 'files',
  '~:': 'change',
  'change:': 'change'
}

/**
 * Splits a search into its terms. A term is a word or a "quoted phrase",
 * optionally led by an operator (`@:alice`, `file:"src/main"`); a term with no
 * operator searches commit messages.
 */
export function parseCommitQuery(text: string): CommitQuery {
  const query: CommitQuery = { messages: [], authors: [], shas: [], files: [], change: null }
  const termPattern = /([=@#?~]:|[a-z]+:)?(?:"([^"]*)"|(\S+))/g
  for (const match of text.matchAll(termPattern)) {
    let operator: string | undefined = match[1]
    let value = match[2]
    if (value === undefined) value = match[3]
    if (operator !== undefined && !(operator in OPERATORS)) {
      // An unknown `word:` is part of the message, not an operator.
      value = operator + value
      operator = undefined
    }
    if (value.length === 0) continue
    addTerm(query, operator, value)
  }
  return query
}

/** Files one term of a query under the kind its operator names. */
function addTerm(query: CommitQuery, operator: string | undefined, value: string): void {
  if (operator === undefined) {
    query.messages.push(value)
    return
  }
  const kind = OPERATORS[operator]
  if (kind === 'change') {
    query.change = value
    return
  }
  query[kind].push(value)
}

/** Whether a query has nothing to search for. */
function isEmptyQuery(query: CommitQuery): boolean {
  const lists = [query.messages, query.authors, query.shas, query.files]
  return lists.every((list) => list.length === 0) && query.change === null
}

/**
 * A page of the commits matching a search, across every branch and tag. Every
 * term has to match, case-insensitively; a file term matches any path
 * containing it. SHAs that name no commit match nothing.
 */
export async function searchCommits(
  worktreePath: string,
  text: string,
  skip: number,
  limit: number
): Promise<CommitSearchPage> {
  const empty: CommitSearchPage = { commits: [], hasMore: false }
  const query = parseCommitQuery(text)
  if (isEmptyQuery(query) || !(await hasCommits(worktreePath))) return empty

  const args = ['-i', '--fixed-strings', '--all-match', `--skip=${skip}`, `--max-count=${limit + 1}`]
  for (const message of query.messages) args.push(`--grep=${message}`)
  for (const author of query.authors) args.push(`--author=${author}`)
  if (query.change !== null) args.push(`-G${query.change}`)

  if (query.shas.length > 0) {
    const shas = await resolvedShas(worktreePath, query.shas)
    if (shas.length === 0) return empty
    args.push('--no-walk', ...shas)
  } else {
    args.push(...ALL_HISTORY)
  }

  if (query.files.length > 0) {
    args.push('--')
    for (const file of query.files) args.push(`:(icase)*${file}*`)
  }

  const page = await log(worktreePath, args)
  return { commits: page.slice(0, limit), hasMore: page.length > limit }
}

/** The given SHAs, full or abbreviated, that name a commit. */
async function resolvedShas(worktreePath: string, shas: string[]): Promise<string[]> {
  const resolved: string[] = []
  for (const sha of shas) {
    if (await resolves(worktreePath, sha)) resolved.push(sha)
  }
  return resolved
}
