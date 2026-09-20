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
  GithubCapabilities,
  GithubComment,
  GithubCreatedIssue,
  GithubIssueType,
  GithubMilestone,
  GithubProjectRef,
  GithubDashboard,
  GithubEventKind,
  GithubIssueDraft,
  GithubIssueItem,
  GithubItemAction,
  GithubLabelChange,
  GithubCloseReason,
  GithubAssigneeChange,
  GithubTimelineEntry,
  GithubTimelineEvent,
  GithubItemDetail,
  GithubItemCommand,
  GithubItemKind,
  GithubItemRef,
  GithubSubIssueProgress,
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
      const failure = new Error(`gh ${args.join(' ')} failed: ${detail}`)
      // A rate limit is about pace, not about the command, so the command is
      // not what the reader needs to see.
      if (isRateLimited(failure)) {
        reject(new Error(rateLimitMessage(failure)))
        return
      }
      reject(failure)
    })
    if (input === undefined) {
      child.stdin.end()
      return
    }
    child.stdin.end(input)
  })
}

/**
 * gh hands GitHub's refusal through whole, which for a rate limit is a request
 * ID, a timestamp and a link to the Terms of Service — none of it the thing the
 * reader needs, which is that this was about pace rather than about them.
 */
export function rateLimitMessage(error: Error): string {
  if (!isRateLimited(error)) return error.message
  // Both keep the words "rate limit", so rewriting one twice is harmless and
  // anything downstream can still recognise what it is holding.
  if (error.message.includes('secondary rate limit')) {
    return 'GitHub rate limit: Grove asked too quickly. It clears in about a minute.'
  }
  return 'GitHub rate limit: this token is out of requests. It clears when the hour does.'
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

// Which optional selections a token allows changes only when the token does, so
// the probes run once per repository per session.
const capabilityCache = new Map<string, GithubCapabilities>()

/** Nothing extra: what a probe run that never got an answer has to report. */
const NO_CAPABILITIES: GithubCapabilities = {
  projects: false,
  issueTypes: false,
  subIssues: false,
  linkedBranches: false
}

/**
 * Whether GitHub refused for rate rather than on the merits. Its own wording
 * covers both the hourly limit and the secondary limiter that answers bursts,
 * and the difference that matters here is not which one — it is that neither is
 * an answer about the request.
 */
export function isRateLimited(error: Error): boolean {
  return error.message.includes('rate limit')
}

/**
 * Whether a selection can be asked for at all: run it as a one-node query of its
 * own and see whether GitHub accepts it. A missing scope and a missing schema
 * field look the same from here, and both mean the same thing — leave it out of
 * the real query — so both answer false.
 *
 * A rate limit is not one of those. It is GitHub declining to decide, and
 * writing it down as "no" would disable projects and issue types for the rest
 * of the session over a burst that clears in a minute, so it is thrown on.
 */
async function probeSelection(
  repoPath: string,
  owner: string,
  name: string,
  selection: string
): Promise<boolean> {
  const query = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { ${selection} }
}`.trim()
  try {
    await runGh(repoPath, [
      'api',
      'graphql',
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-f',
      `query=${query}`
    ])
    return true
  } catch (error) {
    if (isRateLimited(error as Error)) throw error
    return false
  }
}

/**
 * What the queries may select here. Probed rather than assumed: `projectItems`
 * needs the `read:project` scope and `issueType` is not in every schema, and
 * either one, asked for without being allowed, fails the whole document and
 * takes the pane down with it.
 *
 * The probes run one after another rather than together. They happen once per
 * repository per session and nothing is waiting on them, so there is nothing to
 * win by firing four requests at once — and firing four at once is the shape of
 * traffic GitHub's secondary limiter exists to refuse.
 */
export async function fetchCapabilities(repoPath: string): Promise<GithubCapabilities> {
  const cached = capabilityCache.get(repoPath)
  if (cached) return cached
  const repo = await repoRef(repoPath)
  const [owner, name] = repo.nameWithOwner.split('/')
  try {
    const capabilities: GithubCapabilities = {
      projects: await probeSelection(repoPath, owner, name, 'projectsV2(first: 1) { totalCount }'),
      issueTypes: await probeSelection(
        repoPath,
        owner,
        name,
        'issues(first: 1) { nodes { issueType { name } } }'
      ),
      subIssues: await probeSelection(
        repoPath,
        owner,
        name,
        'issues(first: 1) { nodes { subIssuesSummary { total } } }'
      ),
      linkedBranches: await probeSelection(
        repoPath,
        owner,
        name,
        'issues(first: 1) { nodes { linkedBranches(first: 1) { totalCount } } }'
      )
    }
    capabilityCache.set(repoPath, capabilities)
    return capabilities
  } catch {
    // Nothing is cached, so the next refresh asks again. The list still loads;
    // it just loads without the metadata nobody could confirm was there.
    return NO_CAPABILITIES
  }
}

// Sub-issues cap at 100 like every other connection, and a tracking issue with
// more than fifty children is not something this rail could show anyway.
const MAX_SUB_ISSUES = 50

/**
 * The relationship and development selections, which only the detail query
 * wants and only an issue has. Both are newer than the rest of the schema, so
 * both are behind their own probe.
 */
export function relationshipFields(capabilities: GithubCapabilities): string {
  const selections: string[] = []
  if (capabilities.subIssues) {
    selections.push('parent { number title state url }')
    selections.push(
      `subIssues(first: ${MAX_SUB_ISSUES}) { nodes { number title state url } }`,
      'subIssuesSummary { total completed percentCompleted }'
    )
  }
  if (capabilities.linkedBranches) {
    selections.push('linkedBranches(first: 10) { nodes { ref { name } } }')
  }
  return selections.join('\n        ')
}

/**
 * The metadata selections that are not always available, as query text. The
 * milestone is always in the schema and needs no scope; the other two are here
 * only when the probe said so. `issueType` exists on issues alone.
 */
export function optionalFields(capabilities: GithubCapabilities, onIssue: boolean): string {
  const selections = ['milestone { number title state dueOn }']
  if (capabilities.projects) {
    selections.push('projectItems(first: 10) { nodes { project { number title url } } }')
  }
  if (capabilities.issueTypes && onIssue) {
    selections.push('issueType { name color }')
  }
  return selections.join('\n        ')
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
export function dashboardQuery(
  filter: GithubStateFilter,
  capabilities: GithubCapabilities
): string {
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
        ${optionalFields(capabilities, true)}
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
        ${optionalFields(capabilities, false)}
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`.trim()
}

interface GraphqlAuthor {
  login?: string
}

/** The part of a node `optionalFields` selects, shared by the list and detail. */
interface GraphqlOptionalNode {
  milestone?: GithubMilestone | null
  issueType?: GithubIssueType | null
  projectItems?: { nodes: { project: GithubProjectRef | null }[] }
}

interface GraphqlItemNode extends GraphqlOptionalNode {
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

/**
 * The metadata the query may or may not have been allowed to ask for. Left off
 * the item entirely when it was not selected, so "no milestone" and "could not
 * ask about milestones" stay apart in the UI.
 */
function optionalMetadata(node: GraphqlOptionalNode): Partial<GithubIssueItem> {
  const metadata: Partial<GithubIssueItem> = {}
  if (node.milestone !== undefined) metadata.milestone = node.milestone
  if (node.issueType !== undefined) metadata.issueType = node.issueType
  if (node.projectItems) {
    metadata.projects = node.projectItems.nodes
      .map((entry) => entry.project)
      .filter((project): project is GithubProjectRef => project !== null)
  }
  return metadata
}

function toIssueItem(node: GraphqlItemNode): GithubIssueItem {
  return {
    ...optionalMetadata(node),
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
  const capabilities = await fetchCapabilities(repoPath)
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
    `query=${dashboardQuery(options.state, capabilities)}`
  ])
  const payload = parseJson<DashboardResponse>(raw)
  const repository = payload.data.repository
  if (!repository) throw new Error(`GitHub returned no repository for ${repo.nameWithOwner}`)
  return {
    repo: { nameWithOwner: repository.nameWithOwner, url: repository.url },
    viewer: payload.data.viewer ? payload.data.viewer.login : null,
    issues: repository.issues.nodes.map(toIssueItem),
    pulls: repository.pullRequests.nodes.map(toPullItem),
    capabilities,
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
          __typename
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
export function itemDetailQuery(capabilities: GithubCapabilities): string {
  const shared = `id number title url state createdAt updatedAt body authorAssociation
        viewerSubscription locked
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
        isPinned
        ${optionalFields(capabilities, true)}
        ${relationshipFields(capabilities)}
        timelineItems(first: $limit, itemTypes: [${ISSUE_TIMELINE_TYPES.join(', ')}]) {
          nodes {${timelineNodeFields(false)}
          }
        }
      }
      ... on PullRequest {
        ${shared}
        ${optionalFields(capabilities, false)}
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
  source?: { __typename?: string; number?: number; title?: string; url?: string } | null
}

interface DetailNode extends GraphqlOptionalNode {
  __typename: string
  id: string
  viewerSubscription: string | null
  locked: boolean
  isPinned?: boolean
  parent?: GithubItemRef | null
  subIssues?: { nodes: GithubItemRef[] }
  subIssuesSummary?: GithubSubIssueProgress
  linkedBranches?: { nodes: { ref: { name: string } | null }[] }
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
      // A reference can come from either kind, and the pane needs to know which
      // to open it without guessing from the URL.
      kind: node.source.__typename === 'PullRequest' ? 'pull' : 'issue',
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

/**
 * What the item hangs off and what hangs off it, plus the branches GitHub has
 * linked to it. Each part is left off when the query could not ask for it, so
 * "no sub-issues" and "this schema has none" stay apart.
 */
function relationships(node: DetailNode): Partial<GithubItemDetail> {
  const found: Partial<GithubItemDetail> = {}
  if (node.parent !== undefined) found.parent = node.parent
  if (node.subIssues) found.subIssues = node.subIssues.nodes
  if (node.subIssuesSummary) found.subIssueProgress = node.subIssuesSummary
  if (node.linkedBranches) {
    found.linkedBranches = node.linkedBranches.nodes
      .map((entry) => entry.ref)
      .filter((ref): ref is { name: string } => ref !== null)
      .map((ref) => ref.name)
  }
  return found
}

/** One issue or pull request with its body and its whole timeline. */
export async function fetchItem(
  repoPath: string,
  kind: GithubItemKind,
  number: number
): Promise<GithubItemDetail> {
  const repo = await repoRef(repoPath)
  const capabilities = await fetchCapabilities(repoPath)
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
    `query=${itemDetailQuery(capabilities)}`
  ])
  const payload = parseJson<DetailResponse>(raw)
  const node = payload.data.repository?.issueOrPullRequest
  if (!node) throw new Error(`GitHub has no #${number} in ${repo.nameWithOwner}`)
  const timeline = node.timelineItems.nodes
    .map(toEntry)
    .filter((entry): entry is GithubTimelineEntry => entry !== null)
    .sort((a, b) => a.at.localeCompare(b.at))
  return {
    ...optionalMetadata(node),
    ...relationships(node),
    kind,
    id: node.id,
    viewerSubscription: node.viewerSubscription,
    locked: node.locked,
    isPinned: node.isPinned,
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

/**
 * The milestones this repository defines, open and closed alike. Read from the
 * repository rather than from the loaded items, so a milestone nothing is filed
 * against yet can still be picked.
 */
export async function fetchMilestones(repoPath: string): Promise<GithubMilestone[]> {
  const repo = await repoRef(repoPath)
  const raw = await runGh(repoPath, [
    'api',
    `repos/${repo.nameWithOwner}/milestones?state=all&per_page=${MAX_ITEMS}`
  ])
  const parsed =
    parseJson<{ number: number; title: string; state: string; due_on: string | null }[]>(raw)
  return parsed.map((entry) => ({
    number: entry.number,
    title: entry.title,
    state: entry.state,
    dueOn: entry.due_on
  }))
}

/**
 * Build the gh argv for setting an item's milestone, or for clearing it when
 * the title is null (pure, for testing/reuse).
 */
export function milestoneChangeArgs(
  kind: GithubItemKind,
  number: number,
  title: string | null
): string[] {
  const command = kind === 'pull' ? 'pr' : 'issue'
  if (title === null) return [command, 'edit', String(number), '--remove-milestone']
  return [command, 'edit', String(number), '--milestone', title]
}

/** Put an item on a milestone, or take it off one. */
export async function changeMilestone(
  repoPath: string,
  kind: GithubItemKind,
  number: number,
  title: string | null
): Promise<void> {
  await runGh(repoPath, milestoneChangeArgs(kind, number, title))
}

// Watching one thread is a node-level mutation, not a repository setting, so it
// goes through GraphQL against the item's own id rather than through gh's
// porcelain — which has no command for it.
const SUBSCRIPTION_MUTATION = `
mutation($id: ID!, $state: SubscriptionState!) {
  updateSubscription(input: {subscribableId: $id, state: $state}) {
    subscribable { viewerSubscription }
  }
}`.trim()

/**
 * gh reports a missing scope as a wall of GraphQL error text naming every scope
 * the token does have. Turn that into the one line that matters: what could not
 * be done, and the command that would grant it. Anything else passes through —
 * a real failure should still read as itself.
 */
export function scopeHint(error: Error, scope: string, action: string): Error {
  if (!error.message.includes('INSUFFICIENT_SCOPES')) return error
  return new Error(`Your GitHub token cannot ${action}. Run: gh auth refresh -s ${scope}`)
}

/**
 * Subscribe to an item's notifications, or stop them. Needs the `notifications`
 * scope, which gh's default token does not carry — being told which command
 * fixes that beats being handed the raw GraphQL error.
 */
export async function setSubscription(
  repoPath: string,
  nodeId: string,
  subscribed: boolean
): Promise<void> {
  const state = subscribed ? 'SUBSCRIBED' : 'UNSUBSCRIBED'
  try {
    await runGh(repoPath, [
      'api',
      'graphql',
      '-F',
      `id=${nodeId}`,
      '-f',
      `state=${state}`,
      '-f',
      `query=${SUBSCRIPTION_MUTATION}`
    ])
  } catch (error) {
    throw scopeHint(error as Error, 'notifications', 'change what it watches')
  }
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
  merge?: MergePrOptions,
  reason?: GithubCloseReason
): string[] {
  if (kind === 'issue') {
    if (action !== 'close' && action !== 'reopen') {
      throw new Error(`Issues support close and reopen, not "${action}"`)
    }
    // Only closing takes a reason, and only GitHub's two words are accepted.
    if (action === 'close' && reason) {
      return ['issue', 'close', String(number), '--reason', reason]
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
  merge?: MergePrOptions,
  reason?: GithubCloseReason
): Promise<string> {
  const output = await runGh(repoPath, itemActionArgs(kind, number, action, merge, reason))
  return output.trim()
}

/** Build the gh argv for an item command (pure, for testing/reuse). */
export function itemCommandArgs(
  kind: GithubItemKind,
  number: number,
  command: GithubItemCommand
): string[] {
  if (command === 'lock' || command === 'unlock') {
    const base = kind === 'pull' ? 'pr' : 'issue'
    return [base, command, String(number)]
  }
  if (kind === 'pull') {
    throw new Error(`Pull requests support lock and unlock, not "${command}"`)
  }
  // --yes because gh otherwise asks at a terminal nobody is watching; the
  // asking is done in the pane, where the user can see what they are deleting.
  if (command === 'delete') return ['issue', 'delete', String(number), '--yes']
  return ['issue', command, String(number)]
}

/**
 * Deleting an issue needs admin rights, and gh passes GitHub's refusal through
 * as an HTTP status. Say what is actually missing instead.
 */
export function adminHint(error: Error, command: GithubItemCommand): Error {
  if (command !== 'delete') return error
  const refused =
    error.message.includes('403') ||
    error.message.includes('admin rights') ||
    error.message.includes('Resource not accessible')
  if (!refused) return error
  return new Error('Deleting an issue needs admin rights on this repository.')
}

/** Lock, unlock, pin, unpin or delete. */
export async function runItemCommand(
  repoPath: string,
  kind: GithubItemKind,
  number: number,
  command: GithubItemCommand
): Promise<void> {
  try {
    await runGh(repoPath, itemCommandArgs(kind, number, command))
  } catch (error) {
    throw adminHint(error as Error, command)
  }
}

/** Build the gh argv for a transfer (pure, for testing/reuse). */
export function transferArgs(number: number, destination: string): string[] {
  const target = destination.trim()
  if (target.length === 0) throw new Error('A transfer needs a destination repository')
  // gh resolves anything here as a repository reference, so a typo becomes a
  // confusing 404 rather than a refusal. Insist on owner/repo up front.
  if (!/^[\w.-]+\/[\w.-]+$/.test(target)) {
    throw new Error(`"${target}" is not an owner/repo`)
  }
  return ['issue', 'transfer', String(number), target]
}

/** Move an issue to another repository. Its number there is a new one. */
export async function transferIssue(
  repoPath: string,
  number: number,
  destination: string
): Promise<string> {
  const output = await runGh(repoPath, transferArgs(number, destination))
  return output.trim()
}

/** Build the gh argv for an assignment change (pure, for testing/reuse). */
export function assigneeChangeArgs(
  kind: GithubItemKind,
  number: number,
  change: GithubAssigneeChange
): string[] {
  if (change.add.length === 0 && change.remove.length === 0) {
    throw new Error('No assignment change to make')
  }
  const command = kind === 'pull' ? 'pr' : 'issue'
  const args = [command, 'edit', String(number)]
  for (const login of change.add) {
    args.push('--add-assignee', login)
  }
  for (const login of change.remove) {
    args.push('--remove-assignee', login)
  }
  return args
}

/** Assign and unassign people on an item that already exists. */
export async function changeAssignees(
  repoPath: string,
  kind: GithubItemKind,
  number: number,
  change: GithubAssigneeChange
): Promise<void> {
  await runGh(repoPath, assigneeChangeArgs(kind, number, change))
}

// ── Reviewed files ────────────────────────────────────────────────
// GitHub keeps a per-viewer record of which of a pull request's files have been
// read. It is the same state the Files tab on github.com ticks, so a review
// carries between the two rather than being two reviews.

const VIEWED_FILES_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: $limit) {
        nodes { path viewerViewedState }
      }
    }
  }
}`.trim()

const VIEWED_MUTATION = `
mutation($id: ID!, $path: String!) {
  markFileAsViewed(input: {pullRequestId: $id, path: $path}) { clientMutationId }
}`.trim()

const UNVIEWED_MUTATION = `
mutation($id: ID!, $path: String!) {
  unmarkFileAsViewed(input: {pullRequestId: $id, path: $path}) { clientMutationId }
}`.trim()

interface ViewedFilesResponse {
  data: {
    repository: {
      pullRequest: { files: { nodes: { path: string; viewerViewedState: string }[] } } | null
    } | null
  }
}

/**
 * The paths of a pull request's files this viewer has marked as read. One round
 * trip for the whole pull request — the diff itself comes from git, so this is
 * the only per-pull-request call the Files tab makes.
 */
export async function fetchViewedFiles(repoPath: string, number: number): Promise<string[]> {
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
    `limit=${MAX_ITEMS}`,
    '-f',
    `query=${VIEWED_FILES_QUERY}`
  ])
  const pullRequest = parseJson<ViewedFilesResponse>(raw).data.repository?.pullRequest
  if (!pullRequest) throw new Error(`GitHub returned no pull request #${number}`)
  // DISMISSED means "was viewed, then changed underneath you", which is not
  // read — only VIEWED counts.
  return pullRequest.files.nodes
    .filter((node) => node.viewerViewedState === 'VIEWED')
    .map((node) => node.path)
}

/** Mark one of a pull request's files as read, or take the mark off again. */
export async function setFileViewed(
  repoPath: string,
  pullRequestId: string,
  path: string,
  viewed: boolean
): Promise<void> {
  await runGh(repoPath, [
    'api',
    'graphql',
    '-F',
    `id=${pullRequestId}`,
    '-F',
    `path=${path}`,
    '-f',
    `query=${viewed ? VIEWED_MUTATION : UNVIEWED_MUTATION}`
  ])
}
