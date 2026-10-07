// The agent protocol, shared by the main process and the renderer.
//
// grove drives its coding harnesses (Claude Code, Codex, pi) through switchboard
// (`@neoworks/harness`), which speaks ACP for all of them. A session is an
// append-only log of sequenced events: what the harness reported, stored as it
// reported it, beside what the user sent and what grove itself had to say. The
// renderer folds the log into a transcript and never learns which harness
// produced it.
//
// Events are split into what a client sends (`ClientEventBody`) and what the
// run produces (`ServerEventBody`). Both are persisted, so replaying the log
// reconstructs the whole conversation.

import type { RequestPermissionRequest, SessionUpdate as AcpSessionUpdate } from '@neoworks/harness'
import type { TreeFileChange } from './types'

export type SessionStatus = 'idle' | 'running' | 'terminated'

export type IdleReason = 'end_turn' | 'requires_action' | 'aborted' | 'error'

export type ToolPermission = 'allow' | 'ask'

export type ToolPolicy = 'allow' | 'ask' | 'deny'

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type DeliverAs = 'steer' | 'followUp'

export type ConfirmationResult = 'allow' | 'deny' | 'always_session' | 'always_project'

/**
 * How much a session is allowed to do without asking.
 *
 * This is stored on the session rather than held in the window that set it.
 * The main process is what gates tool calls and raises reviews, so a mode it
 * cannot see is a mode that does not take effect — and a mode held in the
 * renderer would not survive reopening the session either.
 *
 *   default      every write and command is put to the user
 *   plan         the tools that change anything are withheld by the harness
 *   acceptEdits  writes go through; commands still ask
 *   bypass       nothing is asked
 */
export type AgentMode = 'default' | 'plan' | 'acceptEdits' | 'bypass'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  ref: string
  mediaType: string
}

/**
 * A slice of a file, attached by grove rather than named for the harness to
 * resolve.
 *
 * Harnesses differ on what an `@path` reference means — Claude expands a bare
 * path and ignores one with a line range, others do nothing at all — so the text
 * that reaches the model is grove's to produce.
 */
export interface FileBlock {
  type: 'file'
  path: string
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  text: string
}

export type UserContentBlock = TextBlock | ImageBlock | FileBlock

export interface ContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface EventEnvelope {
  id: string
  seq: number
  sessionId: string
  createdAt: string
}

export type ClientEventBody =
  | { type: 'user.message'; content: UserContentBlock[]; deliverAs?: DeliverAs }
  | {
      type: 'app.message'
      label: string
      text: string
      deliverAs?: DeliverAs
      /** The agent that sent it, when the message came from one rather than from grove. */
      from?: string
    }
  | {
      type: 'user.tool_confirmation'
      toolUseId: string
      result: ConfirmationResult
      reason?: string
      input?: unknown
    }
  | { type: 'user.interrupt' }
  | { type: 'user.tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'user.command'; name: string; args: string }
  | { type: 'user.compact' }
  | { type: 'user.unqueue'; messageId: string }
  /**
   * Take the conversation back to the event at `fromSeq` (0 for its start), so
   * what follows continues from there; the log keeps what came after. Sent
   * before the message that replaces the one being edited. Only where the
   * harness has `rewind`.
   */
  | { type: 'user.branch'; fromSeq: number }
  | { type: 'user.shell'; command: string; share?: boolean }
  /**
   * An agent's message to a session idle long enough that waking it re-reads
   * its whole context uncached, held for the user to decide on. Recorded only;
   * the wake gate (src/main/agents/wakeGate.ts) holds and releases it.
   */
  | ({ type: 'app.held_message' } & HeldMessage)
  /** The user's answer to a held message. */
  | { type: 'user.decide_held_message'; heldId: string; decision: HeldMessageDecision }

/**
 * What a harness reported, stored exactly as switchboard (`@neoworks/harness`)
 * hands it over.
 *
 * grove adds no vocabulary of its own for what an agent says or does: messages,
 * thoughts, tool calls, plans and compactions are ACP session updates, and
 * everything that reads a transcript folds those. Running totals and a
 * command's streaming output are left off the log — the first is a number on
 * the session, the second is only worth watching while it runs.
 */
export type HarnessEventBody =
  | { type: 'update'; update: AcpSessionUpdate }
  /** A tool call held for a decision; answered by a `user.tool_confirmation`. */
  | { type: 'permission'; request: RequestPermissionRequest }
  /** The harness moved on to another conversation of its own (`/clear`). */
  | { type: 'session_changed'; sessionId: string }

/** What grove itself says about a session: its status, its UI, its notes. */
export type GroveEventBody =
  | { type: 'session.status_running' }
  | { type: 'session.status_idle'; stopReason: IdleReason }
  | { type: 'session.status_terminated'; reason: string }
  | { type: 'session.error'; message: string }
  | {
      type: 'session.notice'
      message: string
      /** The turn ended in the model refusing it, so the prompt that started it is worth rewording. */
      refusal?: boolean
    }
  | { type: 'session.info_changed'; changed: string[] }
  | { type: 'session.forked'; childSessionId: string; afterSeq: number }
  /** The conversation now continues from `fromSeq`; whatever followed it is off the path shown. */
  | { type: 'session.branched'; fromSeq: number }
  | {
      type: 'session.shell_result'
      command: string
      output: string
      exitCode: number
      outcome: string
      share: boolean
      /** The `user.shell` event that started it; absent on logs from before it was recorded. */
      shellId?: string
      /** It was sent to the background; a shared one was handed to the agent when it exited. */
      background?: boolean
    }
  | { type: 'ui.surface'; surfaceId: string; slot: UiSlot; view: UiNode }
  | { type: 'ui.surface'; surfaceId: string; view: null }
  /** Something the agent wants on screen, shown as the event arrives. */
  | { type: 'ui.show'; target: ShowTarget }
  /** The session's notes list, whole, after the user or the agent changed it. */
  | { type: 'session.notes'; notes: SessionNote[] }
  /**
   * The system prompt a conversation started with. A resumed run is handed it
   * back unchanged, so the harness's prompt cache still holds.
   */
  | { type: 'session.system_prompt'; systemPrompt: RecordedPrompt }

/** A system prompt as handed to the harness: in place of its own, or after it. */
export interface RecordedPrompt {
  replace?: string
  append?: string
}

export type ServerEventBody = HarnessEventBody | GroveEventBody

/**
 * One entry on a session's notes list: a reminder of what is still to do,
 * written by the user or by the agent through grove's note tools.
 */
export interface SessionNote {
  id: string
  text: string
  done: boolean
  author: 'user' | 'agent'
}

/**
 * Output of a command an agent is running, streamed as it prints. Not on the
 * event log: the call's result records the output once the command is done.
 */
export interface ShellOutputUpdate {
  sessionId: string
  toolUseId: string
  /** Printed since the last update. */
  text: string
  /** False once the command has exited. */
  running: boolean
  /** Nothing waits on it any more: its call returned, or it was sent to the background. */
  background: boolean
}

/** Everything a running (or just finished) command has printed so far. */
export interface ShellOutputSnapshot {
  toolUseId: string
  text: string
  running: boolean
  background: boolean
}

/** A kind of pane the renderer can open, as it reports them to the agents. */
export interface PaneTypeInfo {
  id: string
  title: string
}

/**
 * What an agent can open in front of the user. Paths are absolute or relative
 * to the session's workspace root.
 */
export type ShowTarget = (
  | { kind: 'diff'; path?: string }
  | { kind: 'github'; number: number }
  | { kind: 'pane'; pane: string }
) & {
  /** What the user is looking at and why, in two or three sentences at most. */
  note?: string
}

/**
 * A place in the code an agent points at. The path is absolute or relative to
 * the session's workspace root; lines are 1-based and inclusive, and a location
 * without them is the whole file.
 */
export interface CodeLocation {
  path: string
  startLine?: number
  endLine?: number
  /** A few words naming the place, for a walkthrough step. */
  title?: string
  /** What this place is, shown on the card and above the marked lines. */
  note?: string
  /** Remarks on single lines, shown above each of them in the editor. */
  annotations?: LineAnnotation[]
  /** What the place looked like when the agent pointed at it, to find it again after edits. */
  anchor?: LocationAnchor
}

/**
 * A location as it was taken down. Line numbers go stale as soon as anything
 * above them changes; the text they held and the commit the file was read at
 * are what find the place again.
 */
export interface LocationAnchor {
  /** HEAD when the agent pointed here, to follow the file through a rename. */
  commit?: string
  /** The range's lines, with up to two lines either side; absent for a whole file. */
  text?: AnchorText
}

export interface AnchorText {
  lines: string[]
  before: string[]
  after: string[]
}

/**
 * Where a location is now. `current`: still at its lines. `moved`: its text
 * was found elsewhere, or its file under another name, and `location` says
 * where. `changed`: its lines no longer read as they did. `removed`: its file
 * is gone.
 */
export type LocationState = 'current' | 'moved' | 'changed' | 'removed'

export interface ResolvedLocation {
  location: CodeLocation
  state: LocationState
}

/** A remark an agent pinned to one line of a location, 1-based. */
export interface LineAnnotation {
  line: number
  text: string
}

/**
 * Harness-contributed UI.
 *
 * A grove tool describes what it wants shown; deciding what that looks like is
 * the renderer's job. Kinds the renderer does not implement fall back to
 * `fallbackText`, which is what lets the vocabulary grow without breaking it.
 */
export type UiSlot = 'transcript' | 'panel'

export type UiTone = 'normal' | 'muted' | 'success' | 'warning' | 'danger'

interface UiNodeBase {
  fallbackText?: string
}

export type UiNode =
  | (UiNodeBase & { kind: 'stack'; children: UiNode[] })
  | (UiNodeBase & { kind: 'text'; text: string; tone?: UiTone })
  | (UiNodeBase & { kind: 'markdown'; text: string })
  | (UiNodeBase & { kind: 'code'; text: string; language?: string })
  | (UiNodeBase & { kind: 'list'; items: string[] })
  | (UiNodeBase & { kind: 'keyValue'; entries: Array<{ key: string; value: string }> })
  | (UiNodeBase & { kind: 'table'; columns: string[]; rows: string[][] })
  | (UiNodeBase & { kind: 'badge'; text: string; tone?: UiTone })
  | (UiNodeBase & { kind: 'divider' })
  /**
   * Places in the code, listed for the user to open one at a time. With
   * `steps`, they are a walkthrough: read in order, stepped through from the
   * editor.
   */
  | (UiNodeBase & {
      kind: 'locations'
      title?: string
      locations: CodeLocation[]
      steps?: boolean
    })

export type EventBody = ClientEventBody | ServerEventBody

/**
 * A slash command written back out as the line the user typed.
 *
 * Harnesses that parse commands out of the prompt send this, and the transcript
 * shows it, so both spell the same command the same way.
 */
export function commandLine(name: string, args: string): string {
  const trimmed = args.trim()
  if (trimmed.length === 0) return `/${name}`
  return `/${name} ${trimmed}`
}

export type SessionEvent = EventBody & EventEnvelope

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ContextUsage {
  usedTokens: number
  contextWindow: number
  remainingTokens: number
  ratio: number
}

export interface QueuedMessage {
  id: string
  text: string
  deliverAs: DeliverAs
  /** Images attached to the message, by blob reference. */
  attachments?: ImageBlock[]
}

/** An agent's message held back from a long-idle session until the user decides. */
export interface HeldMessage {
  heldId: string
  /** The sender's signature, "title (id)". */
  from: string
  /** The sender's session, told how the user decided; null when grove sent it. */
  fromSessionId: string | null
  text: string
  /** When the session's last turn ended: its prompt cache has been cold since. */
  idleSince: string
  /** The context waking it would re-read. */
  contextTokens: number
  /** What re-reading that context costs in dollars, when the model's price is known. */
  wakeCost: number | null
  /** Whether the harness offers `/compact`, to shrink the context before it is read. */
  canCompact: boolean
}

export type HeldMessageDecision = 'send' | 'reject' | 'compact_then_send'

/** The last message in a session, for a listing to show under its name. */
export interface SessionPreview {
  from: 'user' | 'agent'
  /** On one line, and cut short; the row truncates it further to fit. */
  text: string
}

/**
 * A row from the session listing: stored metadata, plus `live` for sessions the
 * main process currently has a harness attached to. `live: false` means nothing
 * is running and the row came straight off disk.
 */
export interface SessionMeta {
  id: string
  title: string
  workspaceRoot: string
  /** The harness driving this session, e.g. `claude`, `codex`, `pi`. */
  harness: string
  provider: string
  model: string
  thinkingLevel: ThinkingLevel
  activeTools: string[] | null
  autoApproveTools: string[]
  /** How much this session may do without asking. */
  permissionMode: AgentMode
  /**
   * Whether the harness runs with grove's prompt and workspace tools in place
   * of its own. Fixed once the session has started, like the harness.
   */
  groveMode: boolean
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
  status: SessionStatus
  stopReason?: IdleReason
  pendingApprovals: string[]
  /** Agent messages held until the user decides whether to wake the session for them. */
  heldMessages: string[]
  lastSeq: number
  live: boolean
  /**
   * Whether a harness has taken a turn on this session.
   *
   * A conversation belongs to the runtime that produced it, so a started
   * session keeps the harness it started on; only the model stays open.
   */
  started: boolean
  /** The last thing said in it, when anything has been. */
  preview: SessionPreview | null
}

/** One session in full, which adds what only a live run knows. */
export interface SessionSnapshot extends SessionMeta {
  messageCount: number
  usage: Usage
  cost: number
  context: ContextUsage
  queued: QueuedMessage[]
}

export interface CreateSessionOptions {
  workspace?: string
  title?: string
  /** Which harness to run. Defaults to the first available one. */
  harness?: string
  provider?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  activeTools?: string[]
  permissionMode?: AgentMode
  groveMode?: boolean
  /** Free-form marks on the session; `grove.parent` names the agent that spawned it. */
  labels?: Record<string, string>
}

export interface SessionUpdate {
  title?: string
  harness?: string
  provider?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  activeTools?: string[] | null
  autoApproveTools?: string[]
  permissionMode?: AgentMode
  groveMode?: boolean
  labels?: Record<string, string>
}

export interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  contextWindow?: number
}

/**
 * What a route needs before a session can take it.
 *
 * `key` is a single secret grove can hold and hand over. `platform` is a cloud
 * sign-in resolved outside grove — an AWS profile, instance role or Google
 * application-default credentials — which grove can neither store nor check, so
 * it is stated rather than demanded.
 */
export interface ProviderCredential {
  kind: 'key' | 'platform'
  /** The environment variables the credential is read from. */
  env: string[]
  /** Whether grove has one right now. Always false for a `platform` sign-in. */
  present: boolean
}

/**
 * One way to reach a model: which provider serves it, under which id.
 *
 * The same model is usually sold by several of them — `claude-fable-5` is
 * `claude-fable-5` at Anthropic, `us.anthropic.claude-fable-5` on Bedrock and
 * `claude-fable-5@default` on Vertex — and a route is what a session is
 * actually started on, so `provider` and `id` together are the selection.
 */
export interface ModelRoute {
  provider: string
  /** The provider's own name, when it has one worth reading. */
  providerLabel?: string
  /** What this provider calls the model; the id the harness is started with. */
  id: string
  /**
   * How the route names itself when that differs from the model — an alias row
   * such as Claude Code's "Default (recommended)", which follows whatever the
   * CLI currently recommends rather than naming a model.
   */
  label?: string
  /**
   * What the harness says about the route. For an alias it names the model the
   * alias currently resolves to: Claude Code's `default` says which model it is.
   */
  description?: string
  /** Where the route sends the session, when it is not the harness's default. */
  endpoint?: string
  credential?: ProviderCredential
  contextWindow?: number
  pricing?: ModelPricing
  /**
   * True when the harness itself listed the route rather than grove deriving it
   * from a catalog: the account is known to be entitled to it.
   */
  native?: boolean
}

/**
 * An endpoint the user brought themselves.
 *
 * Anything that speaks the Anthropic Messages API can host a session — a
 * gateway such as OpenRouter, a LiteLLM container, a local model behind a
 * translating proxy — and none of them is in a public catalog under the user's
 * account. The key itself is not here: `keyVariable` names the variable it is
 * stored under, so this record can be read without leaking one.
 */
export interface CustomEndpoint {
  /** Slug, also the provider id its routes carry. */
  id: string
  label: string
  baseUrl: string
  /** The variable the key lives under, or absent when the endpoint needs none. */
  keyVariable?: string
  /** Model ids the user named, beside whatever the endpoint reports itself. */
  models?: string[]
}

/**
 * A model, and every way this harness can reach it.
 *
 * Grouped by the harness, because only it knows how its providers spell the
 * same model. `key` is stable across restarts, so a picker can keep a selection
 * pointed at the model even when routes come and go.
 */
export interface ModelEntry {
  key: string
  label: string
  description?: string
  routes: ModelRoute[]
}

export type ToolInputView = 'hidden' | 'json' | 'code' | 'command' | 'diff' | 'message'

export type ToolResultView = 'hidden' | 'text' | 'list' | 'file' | 'markdown' | 'code'

/** How a tool wants its call rendered. Intent only — the mapping to widgets is the renderer's. */
export interface ToolDisplay {
  /** What the call does, in words, shown in place of the tool's id: "Start agent". */
  title?: string
  label?: string
  input?: ToolInputView
  result?: ToolResultView
  languageFrom?: string
  /** The call changes a file, so it keeps a row of its own rather than folding into a summary. */
  edits?: boolean
  /**
   * The call is part of the agent's answer (a card of the places it is about), so
   * the prose around it reads as one answer and a finished turn keeps all of it.
   */
  answer?: boolean
  /**
   * The call puts what it did on screen as a surface of its own, so once it has
   * succeeded its row would only repeat it and is left out.
   */
  surface?: boolean
}

/**
 * What a spawned agent will run on, as its approval shows it before it starts.
 * Travels on the approval's tool call under `_meta.grove.spawn`.
 */
export interface SpawnTarget {
  /** Null when neither the call nor its parent names one, leaving grove's default. */
  harness: string | null
  /** The provider serving the model, when the call or the runtime's default names one. */
  provider: string | null
  /** Null when no model was named and the runtime cannot say what it would pick. */
  model: string | null
  /** The model is the one the runtime picks for itself, not one the call named. */
  modelIsDefault: boolean
  /**
   * What the runtime says about that model, when it says anything: for an
   * alias such as Claude Code's `default`, which model it currently is.
   */
  modelDescription: string | null
  /** The effort the call asked for; null leaves it to the runtime. */
  effort: ThinkingLevel | null
}

export interface ToolInfo {
  name: string
  description: string
  summary?: string
  policy: ToolPolicy
  parallelSafe: boolean
  display?: ToolDisplay
  inputSchema: Record<string, unknown>
}

export interface CommandInfo {
  name: string
  description: string
  argumentHint?: string
  kind: string
}

export interface SkillInfo {
  name: string
  description: string
  path: string
}

/** One completion of a composer `!` command, as the user's shell offers it. */
export interface ShellCompletion {
  /** Replaces the word the caret is on. */
  value: string
  /** What it is, when the shell says — fish's "Checkout and switch to a branch". */
  description?: string
}

export interface FileMatch {
  path: string
  score: number
}

/** A file a session has edited, and how much of it its edits changed. */
export interface EditedFile {
  /** Relative to the session's workspace. */
  path: string
  added: number
  removed: number
  /** The session made the file; it did not exist before. */
  created: boolean
}

export interface BlobDescriptor {
  ref: string
  mediaType: string
  filename?: string
  bytes: number
}

/** What a harness can do, so the UI hides the controls it has no answer for. */
export interface HarnessCapabilities {
  /** Tool calls can be held for a decision before they run. */
  approvals: boolean
  /** A turn in flight can be stopped. */
  interrupt: boolean
  /** The model can be changed on a live session. */
  liveModelSwitch: boolean
  /** Thinking levels are honoured. */
  thinking: boolean
  /** Messages can be queued while a turn is running. */
  steering: boolean
  /** grove's own tools (review, chat, onboarding) can be injected. */
  groveTools: boolean
  /** Sessions can run in grove mode: grove's prompt and workspace tools in place of the harness's. */
  groveMode: boolean
  /** Images attached to a message reach the model. */
  attachments: boolean
  /**
   * The conversation can be taken back to before an earlier message and carried
   * on from there (`user.branch`), so a sent message can be edited and rerun.
   */
  rewind: boolean
}

/**
 * The image media types a harness may be handed.
 *
 * The composer takes whatever the file picker gives it, but the model APIs
 * accept a fixed set — anything else is rejected for the whole turn, so it is
 * filtered out and reported instead of being sent.
 */
export const ATTACHABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

/** A harness as the UI sees it: what it is, whether it can run, what it can do. */
export interface HarnessInfo {
  id: string
  label: string
  description: string
  /** Iconify id for the runtime's mark; see renderer `lib/agents/harnessIcons`. */
  icon: string
  capabilities: HarnessCapabilities
  /** False when the runtime is missing or unauthenticated; `detail` says why. */
  available: boolean
  detail: string | null
}

/** Everything the composer, approval card and model picker need for a harness. */
export interface HarnessCatalog {
  harness: string
  tools: ToolInfo[]
  commands: CommandInfo[]
  skills: SkillInfo[]
  models: ModelEntry[]
  default: { provider: string; model: string } | null
}

// ── Replay ──────────────────────────────────────────────────────

/**
 * One tool call that changed the worktree: the tree just before the call was
 * reported and the tree once it settled. The trees are pinned under a private
 * ref, so they outlive the checkpoint cap.
 */
export interface AgentEditStep {
  /** 1-based, in the order the calls settled. */
  index: number
  /** The message that started the turn the call ran in; null before any message. */
  turnSeq: number | null
  /** The event that first reported the call. */
  seq: number
  toolCallId: string
  title: string
  kind: string
  /** When the call settled. */
  at: string
  before: string
  after: string
  files: TreeFileChange[]
}

/** One turn of a replay: the message that started it, and the edits it made. */
export interface ReplayTurn {
  /** The message's seq, or null for edits made before any message. */
  seq: number | null
  at: string
  /** Who sent it: "You", or the label grove or another agent sent it under. */
  from: string
  prompt: string
  steps: AgentEditStep[]
}

/** A session's history as the replay view walks it. */
export interface SessionReplay {
  sessionId: string
  title: string
  workspaceRoot: string
  turns: ReplayTurn[]
}

// ── Prompt blame ────────────────────────────────────────────────

/**
 * The prompt behind lines an agent wrote, as blame reports it. Copied out of
 * the session when the edit was made, so it still reads after the session is
 * deleted.
 */
export interface PromptAttribution {
  sessionId: string
  sessionTitle: string
  harness: string
  /** The message that started the turn; null when the edit preceded any message. */
  turnSeq: number | null
  stepIndex: number
  /** Who sent the prompt: "You", or the label it came under. */
  from: string
  prompt: string
  /** When the edit was made. */
  at: string
  /** What the agent said the change was for; '' when it gave no explanation. */
  explanation: string
  /** What the agent said and thought in the turn before the edit; '' for none. */
  reasoning: string
  /** Whether the session can still be opened. */
  sessionExists: boolean
}

/** The commit that last changed a line, as `git blame` has it. */
export interface LineCommit {
  sha: string
  author: string
  /** Author time, in ms. */
  time: number
  summary: string
}

/** One line, blamed: the commit that last changed it and the prompt that wrote it. */
export interface LineBlame {
  /** Null for a line that is not committed yet, or that blame could not place. */
  commit: LineCommit | null
  /** Null for a line a person wrote, as far as grove knows. */
  prompt: PromptAttribution | null
}

/** A prompt behind some of a commit's added lines, and how many. */
export interface CommitPrompt extends PromptAttribution {
  lines: number
}
