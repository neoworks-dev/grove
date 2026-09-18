// The GitHub dashboard service: the issue and pull-request lists the GitHub
// pane shows, plus the detail view and the write actions (comment, close,
// reopen, ready, merge).
//
// Everything goes through the `gh` CLI, but with an argv array instead of a
// shell string — bodies are arbitrary user text and must never be quoted into a
// command line. The list is one GraphQL round trip so a refresh costs a single
// process spawn; details and writes use the porcelain commands.

import { spawn } from 'child_process'
import { ensureGhReady } from './github'
import type {
  GithubComment,
  GithubDashboard,
  GithubIssueItem,
  GithubItemAction,
  GithubItemDetail,
  GithubItemKind,
  GithubLabel,
  GithubPullItem,
  GithubRepoRef,
  GithubStateFilter,
  GithubStatus,
  MergePrOptions
} from '../shared/types'

// GraphQL `first:` tops out at 100 per connection.
const MAX_ITEMS = 100

/**
 * Run gh with an argv array in a repository directory, returning stdout.
 * `input` is written to stdin, which is how comment bodies are passed.
 */
function runGh(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => reject(new Error(`gh could not be started: ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      const detail = stderr.trim() || `exited with code ${code}`
      reject(new Error(`gh ${args.join(' ')} failed: ${detail}`))
    })
    if (input === undefined) {
      child.stdin.end()
      return
    }
    child.stdin.end(input)
  })
}

/** JSON.parse with the shape named by the caller, instead of a cast per site. */
function parseJson<T>(raw: string): T {
  return JSON.parse(raw)
}

// Which repository a path belongs to changes only when its remotes do, so the
// lookup (a network call) is resolved once per repository per session.
const repoRefCache = new Map<string, GithubRepoRef>()

/** The GitHub repository a local path points at, as gh resolves it. */
export async function repoRef(repoPath: string): Promise<GithubRepoRef> {
  const cached = repoRefCache.get(repoPath)
  if (cached) return cached
  const raw = await runGh(repoPath, ['repo', 'view', '--json', 'nameWithOwner,url'])
  const parsed = parseJson<GithubRepoRef>(raw)
  repoRefCache.set(repoPath, parsed)
  return parsed
}

/**
 * Whether the dashboard can run here: gh present, authenticated, and the path
 * backed by a GitHub repository. Failures are reported, not thrown — the pane
 * turns them into a setup hint instead of an error toast.
 */
export async function fetchStatus(repoPath: string): Promise<GithubStatus> {
  try {
    await ensureGhReady(repoPath)
  } catch (error) {
    const message = (error as Error).message
    return {
      installed: !message.includes('not installed'),
      authenticated: false,
      repo: null,
      error: message
    }
  }
  try {
    return { installed: true, authenticated: true, repo: await repoRef(repoPath), error: null }
  } catch (error) {
    return {
      installed: true,
      authenticated: true,
      repo: null,
      error: `No GitHub repository for this folder: ${(error as Error).message}`
    }
  }
}

// GraphQL enums cannot be passed as gh `-F` variables, so the state sets are
// inlined into the query text. They come from this fixed map, never user input.
const ISSUE_STATES: Record<GithubStateFilter, string> = {
  open: '[OPEN]',
  closed: '[CLOSED]',
  all: '[OPEN, CLOSED]'
}

const PULL_STATES: Record<GithubStateFilter, string> = {
  open: '[OPEN]',
  closed: '[CLOSED, MERGED]',
  all: '[OPEN, CLOSED, MERGED]'
}

/** The one query behind a dashboard refresh: viewer, issues and pulls at once. */
export function dashboardQuery(filter: GithubStateFilter): string {
  return `
query($owner: String!, $name: String!, $limit: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    url
    issues(first: $limit, states: ${ISSUE_STATES[filter]}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url state createdAt updatedAt
        author { login }
        comments { totalCount }
        labels(first: 10) { nodes { name color } }
        assignees(first: 5) { nodes { login } }
      }
    }
    pullRequests(first: $limit, states: ${PULL_STATES[filter]}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url state createdAt updatedAt isDraft additions deletions
        headRefName baseRefName reviewDecision
        author { login }
        comments { totalCount }
        labels(first: 10) { nodes { name color } }
        assignees(first: 5) { nodes { login } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`.trim()
}

interface GraphqlAuthor {
  login?: string
}

interface GraphqlItemNode {
  number: number
  title: string
  url: string
  state: string
  createdAt: string
  updatedAt: string
  author: GraphqlAuthor | null
  comments: { totalCount: number }
  labels: { nodes: GithubLabel[] }
  assignees: { nodes: { login: string }[] }
}

interface GraphqlPullNode extends GraphqlItemNode {
  isDraft: boolean
  additions: number
  deletions: number
  headRefName: string
  baseRefName: string
  reviewDecision: string | null
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

interface DashboardResponse {
  data: {
    viewer: { login: string } | null
    repository: {
      nameWithOwner: string
      url: string
      issues: { nodes: GraphqlItemNode[] }
      pullRequests: { nodes: GraphqlPullNode[] }
    } | null
  }
}

function authorLogin(author: GraphqlAuthor | null | undefined): string {
  if (!author || !author.login) return 'ghost'
  return author.login
}

function toIssueItem(node: GraphqlItemNode): GithubIssueItem {
  return {
    kind: 'issue',
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    author: authorLogin(node.author),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    commentCount: node.comments.totalCount,
    labels: node.labels.nodes,
    assignees: node.assignees.nodes.map((assignee) => assignee.login)
  }
}

/** Check state of the head commit, or null when the PR has no checks. */
function checkState(node: GraphqlPullNode): string | null {
  const commit = node.commits.nodes[0]
  if (!commit) return null
  if (!commit.commit.statusCheckRollup) return null
  return commit.commit.statusCheckRollup.state
}

function toPullItem(node: GraphqlPullNode): GithubPullItem {
  return {
    ...toIssueItem(node),
    kind: 'pull',
    isDraft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    reviewDecision: node.reviewDecision,
    checks: checkState(node)
  }
}

/** Issues and pull requests for the repository, most recently updated first. */
export async function fetchDashboard(
  repoPath: string,
  options: { state: GithubStateFilter; limit: number }
): Promise<GithubDashboard> {
  const repo = await repoRef(repoPath)
  const [owner, name] = repo.nameWithOwner.split('/')
  const limit = Math.max(1, Math.min(options.limit, MAX_ITEMS))
  const raw = await runGh(repoPath, [
    'api',
    'graphql',
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `limit=${limit}`,
    '-f',
    `query=${dashboardQuery(options.state)}`
  ])
  const payload = parseJson<DashboardResponse>(raw)
  const repository = payload.data.repository
  if (!repository) throw new Error(`GitHub returned no repository for ${repo.nameWithOwner}`)
  return {
    repo: { nameWithOwner: repository.nameWithOwner, url: repository.url },
    viewer: payload.data.viewer ? payload.data.viewer.login : null,
    issues: repository.issues.nodes.map(toIssueItem),
    pulls: repository.pullRequests.nodes.map(toPullItem),
    fetchedAt: Date.now()
  }
}

const SHARED_DETAIL_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'author',
  'createdAt',
  'updatedAt',
  'body',
  'labels',
  'assignees',
  'comments'
]

const PULL_DETAIL_FIELDS = [
  ...SHARED_DETAIL_FIELDS,
  'isDraft',
  'additions',
  'deletions',
  'changedFiles',
  'headRefName',
  'baseRefName',
  'reviewDecision',
  'mergeStateStatus',
  'reviews'
]

interface ViewComment {
  id: string
  author: GraphqlAuthor | null
  body: string
  createdAt: string
  url: string
}

interface ViewReview extends ViewComment {
  state: string
  submittedAt: string
}

interface ViewResponse {
  number: number
  title: string
  url: string
  state: string
  author: GraphqlAuthor | null
  createdAt: string
  updatedAt: string
  body: string
  labels: GithubLabel[]
  assignees: { login: string }[]
  comments: ViewComment[]
  isDraft?: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  headRefName?: string
  baseRefName?: string
  reviewDecision?: string | null
  mergeStateStatus?: string
  reviews?: ViewReview[]
}

function toComment(comment: ViewComment): GithubComment {
  return {
    id: comment.id,
    author: authorLogin(comment.author),
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url
  }
}

/**
 * Review summaries read as comments in the thread; only the ones carrying a
 * verdict or a body are worth a row (gh emits an empty PENDING/COMMENTED shell
 * for reviews that exist solely to hold inline comments).
 */
function reviewComments(view: ViewResponse): GithubComment[] {
  if (!view.reviews) return []
  return view.reviews
    .filter((review) => review.body.trim().length > 0 || review.state !== 'COMMENTED')
    .map((review) => ({
      ...toComment(review),
      createdAt: review.submittedAt || review.createdAt,
      reviewState: review.state
    }))
}

/** One issue or pull request with its body and full comment thread. */
export async function fetchItem(
  repoPath: string,
  kind: GithubItemKind,
  number: number
): Promise<GithubItemDetail> {
  const fields = kind === 'pull' ? PULL_DETAIL_FIELDS : SHARED_DETAIL_FIELDS
  const command = kind === 'pull' ? 'pr' : 'issue'
  const raw = await runGh(repoPath, [command, 'view', String(number), '--json', fields.join(',')])
  const view = parseJson<ViewResponse>(raw)
  const comments = view.comments.map(toComment)
  const reviews = reviewComments(view)
  return {
    kind,
    number: view.number,
    title: view.title,
    url: view.url,
    state: view.state,
    author: authorLogin(view.author),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    body: view.body,
    labels: view.labels,
    assignees: view.assignees.map((assignee) => assignee.login),
    comments: [...comments, ...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    isDraft: view.isDraft,
    additions: view.additions,
    deletions: view.deletions,
    changedFiles: view.changedFiles,
    headRefName: view.headRefName,
    baseRefName: view.baseRefName,
    reviewDecision: view.reviewDecision,
    mergeStateStatus: view.mergeStateStatus
  }
}

/** Post a comment. The body goes over stdin, so any text is safe to send. */
export async function addComment(
  repoPath: string,
  kind: GithubItemKind,
  number: number,
  body: string
): Promise<string> {
  if (body.trim().length === 0) throw new Error('Comment body is empty')
  const command = kind === 'pull' ? 'pr' : 'issue'
  const url = await runGh(
    repoPath,
    [command, 'comment', String(number), '--body-file', '-'],
    body
  )
  return url.trim()
}

/** Build the gh argv for a state-changing action (pure, for testing/reuse). */
export function itemActionArgs(
  kind: GithubItemKind,
  number: number,
  action: GithubItemAction,
  merge?: MergePrOptions
): string[] {
  if (kind === 'issue') {
    if (action !== 'close' && action !== 'reopen') {
      throw new Error(`Issues support close and reopen, not "${action}"`)
    }
    return ['issue', action, String(number)]
  }
  if (action !== 'merge') return ['pr', action, String(number)]
  if (!merge) throw new Error('Merging a pull request needs a merge method')
  const args = ['pr', 'merge', String(number), `--${merge.method}`]
  if (merge.deleteBranch) args.push('--delete-branch')
  return args
}

/** Close, reopen, mark ready for review, or merge. Returns gh's output. */
export async function runItemAction(
  repoPath: string,
  kind: GithubItemKind,
  number: number,
  action: GithubItemAction,
  merge?: MergePrOptions
): Promise<string> {
  const output = await runGh(repoPath, itemActionArgs(kind, number, action, merge))
  return output.trim()
}
