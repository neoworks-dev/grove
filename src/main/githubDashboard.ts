// The GitHub dashboard service: the issue and pull-request lists the GitHub
// pane shows, plus the detail view and the write actions (comment, close,
// reopen, ready, merge).
//
// Everything goes through the `gh` CLI, but with an argv array instead of a
// shell string — bodies are arbitrary user text and must never be quoted into a
// command line. The two reads are each one GraphQL round trip, so opening the
// pane or an item costs a single process spawn; writes use the porcelain
// commands, which is where gh does the work of resolving the repository.

import { spawn } from 'child_process'
import { ensureGhReady } from './github'
import type {
  GithubActor,
  GithubComment,
  GithubCreatedIssue,
  GithubDashboard,
  GithubEventKind,
  GithubIssueDraft,
  GithubIssueItem,
  GithubItemAction,
  GithubLabelChange,
  GithubTimelineEntry,
  GithubTimelineEvent,
  GithubItemDetail,
  GithubItemKind,
  GithubLabel,
  GithubLabelDefinition,
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

// Timeline entries worth a row: the ones that say how an item got where it is.
// GitHub has many more (subscriptions, mentions, pins) that only add noise.
const ISSUE_TIMELINE_TYPES = [
  'ISSUE_COMMENT',
  'LABELED_EVENT',
  'UNLABELED_EVENT',
  'CLOSED_EVENT',
  'REOPENED_EVENT',
  'ASSIGNED_EVENT',
  'UNASSIGNED_EVENT',
  'RENAMED_TITLE_EVENT',
  'CROSS_REFERENCED_EVENT'
]

// Reviews, merges and review requests only exist in a pull request's timeline,
// and naming them against an issue is a query error rather than an empty list.
const PULL_TIMELINE_TYPES = [
  ...ISSUE_TIMELINE_TYPES,
  'PULL_REQUEST_REVIEW',
  'MERGED_EVENT',
  'REVIEW_REQUESTED_EVENT'
]

// Timeline pages cap at 100 like every other connection; a thread longer than
// that shows its most recent 100 entries.
const MAX_TIMELINE = 100

const ACTOR_FIELDS = 'login avatarUrl'

/**
 * The inline fragments for the entry kinds a timeline can hold. The pull-only
 * ones are a separate set: GraphQL rejects a fragment on PullRequestReview
 * inside IssueTimelineItems outright, rather than returning an empty list.
 */
function timelineNodeFields(includePullOnly: boolean): string {
  const pullOnly = !includePullOnly
    ? ''
    : `
      ... on PullRequestReview {
        id createdAt submittedAt url body state authorAssociation
        author { ${ACTOR_FIELDS} }
      }
      ... on MergedEvent {
        id createdAt mergeRefName
        actor { ${ACTOR_FIELDS} }
      }
      ... on ReviewRequestedEvent {
        id createdAt
        actor { ${ACTOR_FIELDS} }
        requestedReviewer { ... on User { login } ... on Team { name } }
      }`
  return `
      __typename
      ... on IssueComment {
        id createdAt url body authorAssociation
        author { ${ACTOR_FIELDS} }
      }
      ... on LabeledEvent {
        id createdAt label { name color }
        actor { ${ACTOR_FIELDS} }
      }
      ... on UnlabeledEvent {
        id createdAt label { name color }
        actor { ${ACTOR_FIELDS} }
      }
      ... on ClosedEvent {
        id createdAt stateReason
        actor { ${ACTOR_FIELDS} }
      }
      ... on ReopenedEvent {
        id createdAt
        actor { ${ACTOR_FIELDS} }
      }
      ... on AssignedEvent {
        id createdAt
        actor { ${ACTOR_FIELDS} }
        assignee { ... on User { login } ... on Bot { login } }
      }
      ... on UnassignedEvent {
        id createdAt
        actor { ${ACTOR_FIELDS} }
        assignee { ... on User { login } ... on Bot { login } }
      }
      ... on RenamedTitleEvent {
        id createdAt previousTitle currentTitle
        actor { ${ACTOR_FIELDS} }
      }
      ... on CrossReferencedEvent {
        id createdAt
        actor { ${ACTOR_FIELDS} }
        source {
          ... on Issue { number title url }
          ... on PullRequest { number title url }
        }
      }${pullOnly}`
}

/**
 * The one query behind opening an item: its body, its metadata and its whole
 * timeline. `issueOrPullRequest` resolves either kind, so the caller's `kind` is
 * only used to shape the result rather than to pick a query.
 */
export function itemDetailQuery(): string {
  const shared = `number title url state createdAt updatedAt body authorAssociation
        author { ${ACTOR_FIELDS} }
        labels(first: 20) { nodes { name color } }
        assignees(first: 10) { nodes { login } }`
  return `
query($owner: String!, $name: String!, $number: Int!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        ${shared}
        timelineItems(first: $limit, itemTypes: [${ISSUE_TIMELINE_TYPES.join(', ')}]) {
          nodes {${timelineNodeFields(false)}
          }
        }
      }
      ... on PullRequest {
        ${shared}
        isDraft additions deletions changedFiles
        headRefName baseRefName reviewDecision mergeStateStatus
        timelineItems(first: $limit, itemTypes: [${PULL_TIMELINE_TYPES.join(', ')}]) {
          nodes {${timelineNodeFields(true)}
          }
        }
      }
    }
  }
}`.trim()
}

interface GraphqlActor {
  login?: string
  avatarUrl?: string
}

interface TimelineNode {
  __typename: string
  id: string
  createdAt: string
  submittedAt?: string
  url?: string
  body?: string
  state?: string
  authorAssociation?: string
  author?: GraphqlActor | null
  actor?: GraphqlActor | null
  label?: GithubLabel
  assignee?: { login?: string } | null
  requestedReviewer?: { login?: string; name?: string } | null
  previousTitle?: string
  currentTitle?: string
  stateReason?: string | null
  mergeRefName?: string
  source?: { number?: number; title?: string; url?: string } | null
}

interface DetailNode {
  __typename: string
  number: number
  title: string
  url: string
  state: string
  createdAt: string
  updatedAt: string
  body: string
  authorAssociation: string
  author: GraphqlActor | null
  labels: { nodes: GithubLabel[] }
  assignees: { nodes: { login: string }[] }
  timelineItems: { nodes: TimelineNode[] }
  isDraft?: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  headRefName?: string
  baseRefName?: string
  reviewDecision?: string | null
  mergeStateStatus?: string
}

interface DetailResponse {
  data: {
    repository: { issueOrPullRequest: DetailNode | null } | null
  }
}

// A deleted account has no login and no avatar; GitHub calls it "ghost".
const GHOST: GithubActor = { login: 'ghost', avatarUrl: null }

function toActor(actor: GraphqlActor | null | undefined): GithubActor {
  if (!actor || !actor.login) return GHOST
  return { login: actor.login, avatarUrl: actor.avatarUrl ?? null }
}

/** Which of our event kinds a GraphQL timeline type is, or null to skip it. */
function eventKindOf(typename: string): GithubEventKind | null {
  const kinds: Record<string, GithubEventKind> = {
    LabeledEvent: 'labeled',
    UnlabeledEvent: 'unlabeled',
    ClosedEvent: 'closed',
    ReopenedEvent: 'reopened',
    MergedEvent: 'merged',
    AssignedEvent: 'assigned',
    UnassignedEvent: 'unassigned',
    RenamedTitleEvent: 'renamed',
    CrossReferencedEvent: 'referenced',
    ReviewRequestedEvent: 'review_requested'
  }
  return kinds[typename] ?? null
}

/** The person an assignment or review request is about. */
function subjectOf(node: TimelineNode): string | undefined {
  if (node.assignee && node.assignee.login) return node.assignee.login
  if (!node.requestedReviewer) return undefined
  return node.requestedReviewer.login ?? node.requestedReviewer.name
}

function toEvent(node: TimelineNode, kind: GithubEventKind): GithubTimelineEvent {
  const event: GithubTimelineEvent = {
    id: node.id,
    kind,
    actor: toActor(node.actor),
    createdAt: node.createdAt
  }
  if (node.label) event.label = node.label
  const subject = subjectOf(node)
  if (subject) event.subject = subject
  if (node.previousTitle) event.previousTitle = node.previousTitle
  if (node.currentTitle) event.currentTitle = node.currentTitle
  if (node.stateReason) event.stateReason = node.stateReason
  if (node.mergeRefName) event.mergeRefName = node.mergeRefName
  if (node.source && node.source.number !== undefined) {
    event.source = {
      number: node.source.number,
      title: node.source.title ?? '',
      url: node.source.url ?? ''
    }
  }
  return event
}

function toComment(node: TimelineNode): GithubComment {
  return {
    id: node.id,
    author: toActor(node.author),
    body: node.body ?? '',
    createdAt: node.createdAt,
    url: node.url ?? '',
    authorAssociation: node.authorAssociation ?? 'NONE'
  }
}

/**
 * One timeline node as an entry, or null when it carries nothing to show. A
 * review that holds only inline comments arrives as an empty COMMENTED shell,
 * which GitHub does not draw either.
 */
function toEntry(node: TimelineNode): GithubTimelineEntry | null {
  if (node.__typename === 'IssueComment') {
    return { type: 'comment', at: node.createdAt, comment: toComment(node) }
  }
  if (node.__typename === 'PullRequestReview') {
    const body = node.body ?? ''
    if (body.trim().length === 0 && node.state === 'COMMENTED') return null
    const at = node.submittedAt || node.createdAt
    return {
      type: 'comment',
      at,
      comment: { ...toComment(node), createdAt: at, reviewState: node.state }
    }
  }
  const kind = eventKindOf(node.__typename)
  if (!kind) return null
  return { type: 'event', at: node.createdAt, event: toEvent(node, kind) }
}

/** One issue or pull request with its body and its whole timeline. */
export async function fetchItem(
  repoPath: string,
  kind: GithubItemKind,
  number: number
): Promise<GithubItemDetail> {
  const repo = await repoRef(repoPath)
  const [owner, name] = repo.nameWithOwner.split('/')
  const raw = await runGh(repoPath, [
    'api',
    'graphql',
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${number}`,
    '-F',
    `limit=${MAX_TIMELINE}`,
    '-f',
    `query=${itemDetailQuery()}`
  ])
  const payload = parseJson<DetailResponse>(raw)
  const node = payload.data.repository?.issueOrPullRequest
  if (!node) throw new Error(`GitHub has no #${number} in ${repo.nameWithOwner}`)
  const timeline = node.timelineItems.nodes
    .map(toEntry)
    .filter((entry): entry is GithubTimelineEntry => entry !== null)
    .sort((a, b) => a.at.localeCompare(b.at))
  return {
    kind,
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    author: toActor(node.author).login,
    authorActor: toActor(node.author),
    authorAssociation: node.authorAssociation,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    body: node.body,
    labels: node.labels.nodes,
    assignees: node.assignees.nodes.map((assignee) => assignee.login),
    timeline,
    isDraft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    reviewDecision: node.reviewDecision,
    mergeStateStatus: node.mergeStateStatus
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
  const url = await runGh(repoPath, [command, 'comment', String(number), '--body-file', '-'], body)
  return url.trim()
}

/**
 * The labels this repository defines, for the composer's picker. Read from the
 * repository rather than listed here, so a repo that renames or adds one needs
 * no change in Grove.
 */
export async function fetchLabels(repoPath: string): Promise<GithubLabelDefinition[]> {
  const raw = await runGh(repoPath, [
    'label',
    'list',
    '--limit',
    String(MAX_ITEMS),
    '--json',
    'name,color,description'
  ])
  return parseJson<GithubLabelDefinition[]>(raw)
}

/**
 * People a mention can name: whoever may be assigned an issue here. GitHub's
 * own picker also offers recent participants, which the thread already knows,
 * so the two are merged in the renderer rather than fetched twice.
 */
export async function fetchMentionables(repoPath: string): Promise<GithubActor[]> {
  const repo = await repoRef(repoPath)
  const raw = await runGh(repoPath, ['api', `repos/${repo.nameWithOwner}/assignees`, '--paginate'])
  const parsed = parseJson<{ login: string; avatar_url?: string }[]>(raw)
  return parsed.map((entry) => ({ login: entry.login, avatarUrl: entry.avatar_url ?? null }))
}

/** Build the gh argv for creating an issue (pure, for testing/reuse). */
export function createIssueArgs(draft: GithubIssueDraft): string[] {
  const title = draft.title.trim()
  if (title.length === 0) throw new Error('An issue needs a title')
  // The body goes over stdin; the title is safe as argv, which is never a
  // shell string here.
  const args = ['issue', 'create', '--title', title, '--body-file', '-']
  for (const label of draft.labels) {
    args.push('--label', label)
  }
  return args
}

/**
 * gh prints the new issue's URL, which is the only place its number appears.
 * Throws rather than guessing, so a changed output format is not silently
 * turned into issue 0.
 */
function issueNumberFromUrl(url: string): number {
  const match = /\/issues\/(\d+)\s*$/.exec(url)
  if (!match) throw new Error(`gh issue create printed no issue URL: ${url}`)
  return Number(match[1])
}

/** Create an issue and report where it landed. */
export async function createIssue(
  repoPath: string,
  draft: GithubIssueDraft
): Promise<GithubCreatedIssue> {
  const output = await runGh(repoPath, createIssueArgs(draft), draft.body)
  const url = output.trim().split('\n').pop()
  if (url === undefined) throw new Error('gh issue create printed nothing')
  return { number: issueNumberFromUrl(url), url }
}

/** Build the gh argv for relabelling an item (pure, for testing/reuse). */
export function labelChangeArgs(
  kind: GithubItemKind,
  number: number,
  change: GithubLabelChange
): string[] {
  if (change.add.length === 0 && change.remove.length === 0) {
    throw new Error('No label change to make')
  }
  const command = kind === 'pull' ? 'pr' : 'issue'
  const args = [command, 'edit', String(number)]
  for (const label of change.add) {
    args.push('--add-label', label)
  }
  for (const label of change.remove) {
    args.push('--remove-label', label)
  }
  return args
}

/** Add and remove labels on an item that already exists. */
export async function changeLabels(
  repoPath: string,
  kind: GithubItemKind,
  number: number,
  change: GithubLabelChange
): Promise<void> {
  await runGh(repoPath, labelChangeArgs(kind, number, change))
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
