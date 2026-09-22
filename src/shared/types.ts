// Types shared across main, preload, and renderer.

export interface Worktree {
  id: string // stable id derived from path
  name: string // last path segment
  path: string
  branch: string // branch name or detached HEAD short sha
  isMain: boolean
  isDetached: boolean
  locked: boolean
  dirty: boolean
  portSlot: number // deterministic port-allocation slot
}

export interface BranchList {
  current: string
  all: string[]
  local: string[]
}

export type DiffChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export interface DiffFile {
  path: string
  oldPath?: string // for renames
  changeType: DiffChangeType
  staged: boolean
}

export interface DiffSides {
  path: string
  original: string // content at base/HEAD (empty for added/untracked)
  modified: string // working-tree or staged content
  language: string
}

// One changed region, line ranges 1-based. A count of 0 marks a pure
// insertion (original side) or deletion (modified side); `*Start` then points
// at the line the change sits after.
export interface DiffHunk {
  originalStart: number
  originalCount: number
  modifiedStart: number
  modifiedCount: number
}

// The checked-out branch against the upstream it tracks. `upstream` is null when
// the branch tracks nothing; ahead/behind are then 0.
export interface BranchStatus {
  branch: string
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
}

// Changed line ranges for a file, parsed from `git diff` hunk headers. Empty
// for untracked files, where every modified line is an addition.
export interface DiffHunks {
  path: string
  hunks: DiffHunk[]
}

// ── Diff stats (added/removed line counts) ──────────────────────

// Per-file added/removed line counts. `added`/`removed` are -1 for binary
// files (git reports `-` in numstat).
export interface DiffFileStat {
  path: string
  added: number
  removed: number
}

// Aggregate diff stats for a worktree vs HEAD (staged + unstaged + untracked).
export interface DiffStats {
  added: number
  removed: number
  files: DiffFileStat[]
}

// ── Worktree-into-worktree merge ────────────────────────────────

// no-ff always creates a merge commit; ff-only refuses anything but a
// fast-forward; ff allows a fast-forward, falling back to a merge commit.
export type MergeMode = 'no-ff' | 'ff-only' | 'ff'

export interface MergeCommitSummary {
  sha: string
  subject: string
}

// What a merge of sourceBranch into the target worktree would do, shown before
// the user confirms.
export interface MergePreview {
  commits: MergeCommitSummary[]
  stat: string
  canFastForward: boolean
  alreadyMerged: boolean
  // Uncommitted work in the source worktree that the merge would NOT include.
  sourceDirty: boolean
}

export type MergeResult =
  | { status: 'up-to-date' }
  | { status: 'merged'; summary: string; fastForward: boolean }
  | { status: 'conflict'; files: string[]; summary: string }

// ── Conflict hunks ──────────────────────────────────────────────

// One conflicted region of a working-tree file, as git left it between its
// `<<<<<<<` and `>>>>>>>` markers.
export interface ConflictHunk {
  // 1-based lines of the opening and closing marker, so the editor can put the
  // cursor on the conflict.
  startLine: number
  endLine: number
  // What git wrote beside each marker — the branch names, usually `HEAD` and
  // the branch being merged in. Empty when a marker carries no label.
  oursLabel: string
  theirsLabel: string
  ours: string[]
  theirs: string[]
  // The common ancestor's lines, present only under diff3 conflict style.
  base?: string[]
}

export interface ConflictedFile {
  path: string
  hunks: ConflictHunk[]
}

// Which side of one conflict to keep. `both` keeps ours followed by theirs.
export type ConflictChoice = 'ours' | 'theirs' | 'both'

// A merge underway in a worktree. `inProgress` outlives the conflicts: once
// every one is resolved and staged the merge is still open, waiting to be
// committed, and that is when finishing it is the only thing left to offer.
export interface MergeState {
  inProgress: boolean
  files: ConflictedFile[]
}

// ── Cross-agent + agent↔user chat ───────────────────────────────

// One message on a worktree's shared channel. `from.kind` distinguishes the
// user from an agent; `to` optionally targets one agent by name.
export interface WorktreeChatMessage {
  id: string
  worktreeId: string
  // instanceId distinguishes two runs of the same adapter (e.g. two "claude").
  from: { kind: 'user' | 'agent'; name: string; instanceId?: string }
  text: string
  ts: number
  to?: string
}

// ── Local-only checkpoints ──────────────────────────────────────

// What caused a checkpoint to be taken.
export type CheckpointTrigger =
  | 'agent-turn-end'
  | 'user-message'
  | 'pre-restore'
  | 'pre-merge'
  | 'manual'
  // Taken when a review batch opens. Its tree is the baseline every staged file
  // in that batch is diffed against, and the checkpoint ref keeps it reachable
  // until the review is resolved.
  | 'review-baseline'

// One working-tree snapshot. The tree/commit live in the repo object DB under a
// private ref (refs/workbench/checkpoints/**, never pushed); this metadata is
// persisted in RepoState. `n` is a monotonic per-worktree counter.
export interface CheckpointMeta {
  n: number
  commit: string
  tree: string
  ts: number
  trigger: CheckpointTrigger
  agent?: string
  chatId?: string
  note?: string
}

// ── Inline agent edit (per-hunk accept/reject) ──────────────────

// One hunk of an inline edit, with its line bodies. `beforeStart`/`afterStart`
// are 1-based line numbers in the pre-edit snapshot / current file.
export interface InlineHunk {
  beforeStart: number
  removed: string[]
  afterStart: number
  added: string[]
}

// The output line range (1-based) of an applied hunk after rebuild, tagged with
// the hunk's original index so the overlay can repaint the right rows.
export interface AppliedRange {
  hunkIndex: number
  start: number
  count: number
}

// ── Agent write review ──────────────────────────────────────────

// How a review was raised. 'gated' is a single not-yet-applied write held at the
// permission prompt; 'agent' is a batch the agent itself closed by calling
// request_review; 'turn-end' is the backstop that closes whatever is still
// staged when the agent goes idle.
export type ReviewOrigin = 'gated' | 'agent' | 'turn-end'

// One file in a review. `baseline` is its content before the batch (empty for a
// file the agent created), `current` is what it holds now — or, for a gated
// review, what the agent proposes to write.
export interface ReviewFile {
  relPath: string
  baseline: string
  current: string
  hunks: InlineHunk[]
  // The agent removed the file. Distinguishes a deletion from a write that
  // emptied the file, so accepting it deletes rather than leaving an empty file.
  deleted?: boolean
}

// A set of agent writes awaiting review, raised to the user as one request.
export interface ReviewBatch {
  id: string
  worktreeId: string
  agent: string
  chatId: string
  origin: ReviewOrigin
  // The agent's own description of the unit of work, when it closed the batch.
  summary?: string
  files: ReviewFile[]
  // Present only for 'gated': the permission request to resolve on decision.
  permissionId?: string
  toolName?: string
}

// The user's verdict on one hunk, with an optional note for the agent.
export interface HunkDecision {
  relPath: string
  hunkIndex: number
  accepted: boolean
  comment?: string
}

// A finished review, applied to disk and reported back to the agent.
export interface ReviewResolution {
  batchId: string
  decisions: HunkDecision[]
}

// ── Docked side panels (retired) ────────────────────────────────
// The sidebar and the agent panel are ordinary leaves of the split tree now.
// These types survive only so a layout saved before that can be read back once
// and folded into the tree; nothing writes them any more.

export type DockSide = 'left' | 'right'

// One docked panel: which pane type it hosted, whether it was open, and its
// size in pixels along the dock axis (width for left/right docks).
export interface DockPaneState {
  paneType: string
  open: boolean
  size: number
}

export interface DockLayoutState {
  left: DockPaneState
  right: DockPaneState
}

// ── Ship-it chain (PR / merge) ──────────────────────────────────

export interface OpenPrOptions {
  title: string
  body: string
  base: string
}

export type PrMergeMethod = 'squash' | 'merge' | 'rebase'

export interface MergePrOptions {
  method: PrMergeMethod
  deleteBranch: boolean
}

export interface ArchiveOptions {
  deleteBranch: boolean
  force: boolean
}

// ── GitHub dashboard (issues + pull requests) ───────────────────

export type GithubItemKind = 'issue' | 'pull'

/** Which states the dashboard asks GitHub for. */
export type GithubStateFilter = 'open' | 'closed' | 'all'

export interface GithubLabel {
  name: string
  /** Six-digit hex, no leading '#', as GitHub stores it. */
  color: string
}

/** A label as the repository defines it, for the pickers that offer them. */
export interface GithubLabelDefinition extends GithubLabel {
  description: string
}

/** A repository milestone, as the sidebar shows one and the filter menu lists it. */
export interface GithubMilestone {
  number: number
  title: string
  /** OPEN | CLOSED, as GitHub stores it. */
  state: string
  /** ISO timestamp the milestone is due, or null when it has no date. */
  dueOn: string | null
}

/** An organisation's issue type — Bug, Feature, Task, whatever it defines. */
export interface GithubIssueType {
  name: string
  /** GitHub's palette name for the type: RED, BLUE, GRAY, … */
  color: string
}

/** A ProjectV2 board an item sits on. */
export interface GithubProjectRef {
  number: number
  title: string
  url: string
}

/**
 * Which optional GraphQL selections this token and this schema allow.
 *
 * Projects are ProjectV2 and need the `read:project` scope; issue types are not
 * in every schema. A selection that is not allowed fails the *whole* document
 * rather than coming back empty, so each is probed once and then either
 * included in the queries or left out of them entirely.
 */
export interface GithubCapabilities {
  projects: boolean
  issueTypes: boolean
  /** Sub-issues and the parent an issue hangs off. */
  subIssues: boolean
  /** The branches GitHub has linked to an issue. */
  linkedBranches: boolean
}

/** A pointer to another issue, as a relationship carries one. */
export interface GithubItemRef {
  number: number
  title: string
  /** OPEN | CLOSED. */
  state: string
  url: string
}

/** How far down its sub-issues a tracking issue is. */
export interface GithubSubIssueProgress {
  total: number
  completed: number
  percentCompleted: number
}

/** A new issue, as composed in the pane and handed to `gh issue create`. */
export interface GithubIssueDraft {
  title: string
  body: string
  /** Label names, which must already exist on the repository. */
  labels: string[]
}

interface GithubItemShared {
  number: number
  title: string
  url: string
  /** OPEN | CLOSED for issues; OPEN | CLOSED | MERGED for pull requests. */
  state: string
  author: string
  createdAt: string
  updatedAt: string
  labels: GithubLabel[]
  assignees: string[]
  /** Null when the item has none. Absent when the query could not ask. */
  milestone?: GithubMilestone | null
  issueType?: GithubIssueType | null
  /** Boards the item sits on; absent without the `read:project` scope. */
  projects?: GithubProjectRef[]
}

export interface GithubIssueItem extends GithubItemShared {
  kind: 'issue'
  commentCount: number
}

export interface GithubPullItem extends GithubItemShared {
  kind: 'pull'
  commentCount: number
  isDraft: boolean
  additions: number
  deletions: number
  headRefName: string
  baseRefName: string
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED, or null when unset. */
  reviewDecision: string | null
  /** Rollup of the head commit's checks: SUCCESS | FAILURE | PENDING | …, or null. */
  checks: string | null
}

export type GithubItem = GithubIssueItem | GithubPullItem

export interface GithubRepoRef {
  nameWithOwner: string
  url: string
}

export interface GithubDashboard {
  repo: GithubRepoRef
  /** Login of the authenticated user, so the UI can mark "yours". */
  viewer: string | null
  issues: GithubIssueItem[]
  pulls: GithubPullItem[]
  /** What this token could be asked for, so the UI hides what is not there. */
  capabilities: GithubCapabilities
  /** Epoch ms of the fetch, for the "updated Xs ago" hint. */
  fetchedAt: number
}

/** Whoever did a thing, with what the UI needs to show them. */
export interface GithubActor {
  login: string
  /** GitHub's avatar URL, or null for the deleted-user placeholder. */
  avatarUrl: string | null
}

export interface GithubComment {
  id: string
  author: GithubActor
  body: string
  createdAt: string
  url: string
  /** OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE — the badge GitHub puts
   *  beside a name to say how the author relates to the repository. */
  authorAssociation: string
  /** Review summaries are shown inline with issue comments, tagged by state. */
  reviewState?: string
}

/**
 * Everything that is not a comment: the state changes, labellings and renames
 * GitHub draws as one-line entries down the timeline's rail.
 */
export type GithubEventKind =
  | 'labeled'
  | 'unlabeled'
  | 'closed'
  | 'reopened'
  | 'merged'
  | 'assigned'
  | 'unassigned'
  | 'renamed'
  | 'referenced'
  | 'review_requested'

export interface GithubTimelineEvent {
  id: string
  kind: GithubEventKind
  actor: GithubActor
  createdAt: string
  /** labeled / unlabeled. */
  label?: GithubLabel
  /** assigned / unassigned / review_requested. */
  subject?: string
  /** renamed. */
  previousTitle?: string
  currentTitle?: string
  /** closed, when GitHub gives a reason (completed / not planned). */
  stateReason?: string
  /** merged. */
  mergeRefName?: string
  /** referenced — the issue or pull request that mentioned this one. */
  source?: { kind: GithubItemKind; number: number; title: string; url: string }
}

/** One entry of the thread, before the UI folds runs of them together. */
export type GithubTimelineEntry =
  | { type: 'comment'; at: string; comment: GithubComment }
  | { type: 'event'; at: string; event: GithubTimelineEvent }

export interface GithubItemDetail extends GithubItemShared {
  kind: GithubItemKind
  /** The GraphQL node id, which the subscription mutation is addressed to. */
  id: string
  body: string
  /** Who opened it, for the first card of the thread. */
  authorActor: GithubActor
  authorAssociation: string
  /** Comments and events in one time-ordered list. */
  timeline: GithubTimelineEntry[]
  /** SUBSCRIBED | UNSUBSCRIBED | IGNORED, or null when GitHub has no opinion. */
  viewerSubscription?: string | null
  /** Whether the conversation is locked to people without write access. */
  locked: boolean
  /** Issues only: pinned to the top of the repository's issue list. */
  isPinned?: boolean
  /** The issue this one hangs off, or null when it hangs off nothing. */
  parent?: GithubItemRef | null
  subIssues?: GithubItemRef[]
  subIssueProgress?: GithubSubIssueProgress
  /** Branch names GitHub has linked to the issue. */
  linkedBranches?: string[]
  // Pull-request-only fields.
  isDraft?: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  headRefName?: string
  baseRefName?: string
  reviewDecision?: string | null
  mergeStateStatus?: string
  /** Whether the base repository's maintainers may push to a fork's branch. */
  maintainerCanModify?: boolean
  /**
   * The repository the head branch lives on, which for a fork is not the one
   * the pull request was opened against. Null when the fork is gone.
   */
  headRepository?: {
    url: string
    nameWithOwner: string
    viewerPermission: string | null
  } | null
}

// The branch a resolved pull request is pushed back to. It lives on the head
// repository, which for a fork is not the one the pull request was opened
// against — so the push needs the URL, not a remote name.
export interface PrPushTarget {
  repository: string
  branch: string
  url: string
}

// Where a checked-out pull request stands against the pull request itself:
// whether resolving its conflicts is underway, and whether the result can go
// back to GitHub.
export interface PrCheckoutState {
  /** The `pr-<n>` worktree, or null when the pull request is not checked out. */
  worktreeId: string | null
  mergeInProgress: boolean
  /** Files still carrying conflicts in that worktree. */
  unresolved: number
  /** Commits the checkout has that the pull request's head branch does not. */
  ahead: number
  /** Where a push would go, or null when pushing is not possible. */
  pushTarget: PrPushTarget | null
  /** Why pushing is not possible, when it is not. */
  blockedReason: string | null
}

// The result of starting a conflict resolution: the checkout it happens in, and
// what merging the base branch into it did.
export interface PrConflictResolution {
  worktreeId: string
  merge: MergeResult
}

/** A relabelling of an item that already exists. */
export interface GithubLabelChange {
  add: string[]
  remove: string[]
}

/** Where a freshly created issue landed. */
export interface GithubCreatedIssue {
  number: number
  url: string
}

/** Non-comment actions the dashboard can run against an item. */
export type GithubItemAction = 'close' | 'reopen' | 'ready' | 'merge'

/**
 * The commands beyond changing state, which the sidebar keeps apart from the
 * rest: locking speaks for the repository, and deleting is gone for good.
 * Pull requests can only be locked and unlocked.
 */
export type GithubItemCommand = 'lock' | 'unlock' | 'pin' | 'unpin' | 'delete'

/**
 * Why an issue was closed. GitHub distinguishes the two in its own UI and shows
 * a different icon for each, so closing here has to be able to say which.
 */
export type GithubCloseReason = 'completed' | 'not planned'

/** An assignment change on an item that already exists. */
export interface GithubAssigneeChange {
  add: string[]
  remove: string[]
}

export interface GithubStatus {
  installed: boolean
  authenticated: boolean
  repo: GithubRepoRef | null
  /** Why the dashboard cannot load, phrased for the UI. */
  error: string | null
}

/** One file a pull request changes. */
export interface GithubPrFile {
  path: string
  /** Where the file was before it was renamed. */
  oldPath?: string
  changeType: DiffChangeType
  added: number
  removed: number
  /** Binary files have no line counts and no side-by-side view. */
  binary: boolean
}

/**
 * A pull request's changed files, and the two commits its diff runs between.
 * `baseOid` is the merge base rather than the base branch tip, so the diff shows
 * what the pull request did and not what landed on the base branch beside it.
 */
export interface GithubPrDiff {
  baseOid: string
  headOid: string
  files: GithubPrFile[]
}

/** Which side of a diff a comment is attached to. */
export type GithubDiffSide = 'LEFT' | 'RIGHT'

/** One comment inside a review thread. */
export interface GithubReviewComment {
  id: string
  author: GithubActor
  body: string
  createdAt: string
  /** True until the review holding it is submitted — nobody else can see it. */
  pending: boolean
  /** Whether GitHub will let this viewer take it back. */
  viewerCanDelete: boolean
}

/**
 * A conversation about one place in a pull request. `line` is null for a thread
 * about the file as a whole, and for one whose line no longer exists in the
 * diff — GitHub calls that outdated, and has nowhere to put it.
 */
export interface GithubReviewThread {
  id: string
  path: string
  line: number | null
  side: GithubDiffSide
  isResolved: boolean
  /** Part of a review the viewer has not submitted yet. */
  pending: boolean
  comments: GithubReviewComment[]
}

/** A pull request's review threads, and the viewer's unsubmitted review. */
export interface GithubPrReview {
  threads: GithubReviewThread[]
  /** The viewer's pending review, or null when they have not started one. */
  pendingReviewId: string | null
}

/** What submitting a review says about the pull request. */
export type GithubReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

/** Where a new comment goes, and what it says. */
export interface GithubReviewDraft {
  path: string
  /** Null makes it a comment on the whole file rather than on a line. */
  line: number | null
  side: GithubDiffSide
  body: string
}

// ── Config schema (repo-root YAML) ──────────────────────────────

export interface WorkbenchConfig {
  workbench: {
    worktrees_dir: string
    default_base_branch: string
  }
  ports: {
    start: number
    count_per_worktree: number
  }
  setup: {
    once: string[]
    per_worktree: string[]
  }
  services: Record<string, ServiceConfig>
  agents: Record<string, AgentConfig>
}

export interface ServiceConfig {
  command: string
  preview?: string
  health?: string
  log?: string
}

// A selectable agent option (mode / model / effort). `value` is the concrete
// value passed to the SDK when chosen (e.g. a permission mode or effort level).
export interface AgentOption {
  label: string
  value: string
}

export interface AgentConfig {
  command: string // adapter id / display name
  interactive?: boolean // supports live permission prompts (claude)
  modes?: AgentOption[]
  models?: AgentOption[]
  efforts?: AgentOption[]
}

// Structured launch options sent from the renderer (replaces CLI flag strings).
export interface AgentLaunchOptions {
  prompt?: string
  mode?: string
  model?: string
  effort?: string
  // Extra text appended to the adapter's system prompt (claude only today).
  appendSystemPrompt?: string
  // Marks an AGENTS.md onboarding run; claude mounts the grove-intro tools.
  intro?: boolean
}

// ── Mid-run message queue ────────────────────────────────────────
// A message typed while the agent runs. Injected live when the adapter
// supports it, otherwise held and auto-submitted when the run ends.
export interface QueuedMessage {
  id: string
  text: string
  createdAt: number
}

export type AgentSendResult =
  | { delivered: 'injected' } // pushed into the live turn loop
  | { delivered: 'queued'; id: string } // run active, no live injection
  | { delivered: 'started' } // no run active; started a resumed run

export interface AgentQueueEvent {
  worktreeId: string
  name: string
  chatId: string
  queue: QueuedMessage[]
  // Present when an explicit user stop flushed pending items, so the
  // renderer can restore their text into the composer.
  cleared?: QueuedMessage[]
}

// ── Dynamic slash commands (discovered from the provider) ───────
export interface AgentSlashCommand {
  name: string
  description: string
  argumentHint: string
}

export interface AgentCommandsEvent {
  worktreeId: string
  name: string
  commands: AgentSlashCommand[]
}

// ── Named chats (multiple conversations per worktree+agent) ─────
// Each chat owns a continuation token and its own on-disk transcript, so a
// worktree can hold several resumable, individually named conversations.
export interface ChatMeta {
  id: string
  name: string
  session: string // provider continuation token ('' = fresh)
  createdAt: number
  updatedAt: number
}

export interface AgentChats {
  activeId: string
  chats: ChatMeta[]
}

// ── Interactive permissions (agent → user → agent) ──────────────

export interface PermissionRequestEvent {
  id: string // resolve target
  worktreeId: string
  agent: string
  chatId: string
  toolName: string
  title: string
  path: string | null
  input: Record<string, unknown>
}

export type PermissionDecision =
  { behavior: 'allow'; remember: boolean } | { behavior: 'deny'; message: string }

// ── Interactive dialogs (agent → user → agent) ──────────────────
// The claude SDK surfaces questions (and other blocking dialogs) via its
// `onUserDialog` callback, separate from tool permissions. `dialogKind` selects
// the renderer; `payload`/`result` shapes are defined by the SDK per kind (the
// question kind carries a `questions` array). Kept opaque so new kinds work.

export interface AgentDialogRequest {
  id: string
  worktreeId: string
  agent: string
  chatId: string
  dialogKind: string
  payload: Record<string, unknown>
}

export type AgentDialogDecision =
  { behavior: 'completed'; result: unknown } | { behavior: 'cancelled' }

// ── Runtime state ───────────────────────────────────────────────

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'unhealthy'

/**
 * A terminal the daemon is running.
 *
 * Shells outlive grove, so a window that opens asks what is still there and
 * takes those over; this is what it gets back per terminal.
 */
export interface TerminalSessionInfo {
  id: string
  title: string
  cwd: string
  worktreeId: string | null
  cols: number
  rows: number
  startedAt: number
}

export interface ServiceRuntime {
  worktreeId: string
  name: string
  status: ServiceStatus
  pid: number | null
  previewUrl: string | null
  healthUrl: string | null
  logPath: string
  ports: number[]
}

export type AgentStatus = 'stopped' | 'running' | 'exited' | 'error'

export interface AgentRuntime {
  worktreeId: string
  name: string
  // Concurrency unit: multiple instances of the same adapter can run at once in
  // one worktree, each identified by its chatId (its conversation).
  chatId: string
  // Human label for the instance (the chat name, e.g. "Claude #2").
  label: string
  status: AgentStatus
  pid: number | null
  command: string
  exitCode: number | null
  logPath: string
}

export interface FileNode {
  name: string
  path: string // absolute
  relPath: string // relative to worktree root
  isDir: boolean
}

// A ripgrep content-search hit (file is relative to the search root).
export interface SearchMatch {
  file: string
  line: number
  column: number
  text: string
}

// ── Editor extensions (grammars / themes / LSP servers) ─────────

export interface CatalogEntry {
  id: string
  kind: 'grammar' | 'theme' | 'lsp'
  name: string
  description?: string
  license?: string
  extensions?: string[] // grammar file extensions
  wasmUrl?: string
  highlightsUrl?: string
  scheme?: 'dark' | 'light' // theme
  palette?: Record<string, string> // theme partial palette overrides
  lsp?: { command: string; args?: string[]; languages: string[]; install?: string }
}

export interface InstalledExtension {
  id: string
  kind: string
  enabled: boolean
}

export interface GrammarPayload {
  wasm: Uint8Array
  highlights: string
}

// ── LSP (language servers) ──────────────────────────────────────

export interface LspPosition {
  line: number // 0-based
  character: number // 0-based
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspCompletion {
  label: string
  detail?: string
  kind?: number
  insertText?: string
}

export interface LspDiagnostic {
  range: LspRange
  message: string
  severity?: number // 1 error, 2 warning, 3 info, 4 hint
  source?: string
}

export interface LspDiagnosticsEvent {
  uri: string
  diagnostics: LspDiagnostic[]
}

// ── IPC event payloads (main → renderer) ────────────────────────

export interface LogLineEvent {
  worktreeId: string
  source: 'service' | 'agent'
  name: string
  line: string
}

export interface ServiceStatusEvent {
  runtime: ServiceRuntime
}

export interface AgentStatusEvent {
  runtime: AgentRuntime
}

export interface RepoInfo {
  path: string
  name: string
  currentBranch: string
  // No AGENTS.md/CLAUDE.md at the repo root -> offer the AGENTS.md setup stage.
  hasAgentsFile: boolean
  // No workbench.yaml at the repo root -> offer the config setup stage.
  hasConfig: boolean
}

// A service entry a detector proposes for workbench.yaml. Crosses IPC so the
// setup wizard can render proposals for the user to review and edit.
export interface ServiceProposal extends ServiceConfig {
  name: string
  // Detector id, so the wizard can show where a proposal came from.
  source: string
  // False when the command keeps a port Grove does not control, meaning two
  // worktrees running this service will collide.
  usesPort: boolean
}
