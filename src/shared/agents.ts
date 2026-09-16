// The agent protocol, shared by the main process and the renderer.
//
// grove drives several coding harnesses (Claude, Codex, pi) through one
// vocabulary: a session is an append-only log of sequenced events, and every
// harness adapter translates its SDK's stream into these bodies. The renderer
// folds the log into a transcript and never learns which harness produced it.
//
// Events are split into what a client sends (`ClientEventBody`) and what the
// run produces (`ServerEventBody`). Both are persisted, so replaying the log
// reconstructs the whole conversation.

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
  | { type: 'user.branch'; fromSeq: number }
  | { type: 'user.shell'; command: string; share?: boolean }

export type ServerEventBody =
  | { type: 'session.status_running' }
  | { type: 'session.status_idle'; stopReason: IdleReason }
  | { type: 'session.status_terminated'; reason: string }
  | { type: 'session.error'; message: string }
  | { type: 'session.notice'; message: string }
  | { type: 'session.info_changed'; changed: string[] }
  | { type: 'session.compacted'; summary: string; droppedMessages: number }
  /** The harness dropped the conversation and started a fresh one (`/clear`). */
  | { type: 'session.cleared' }
  /** What a command the harness ran itself has to say (`/usage`, `/help`, …). */
  | { type: 'session.command_output'; text: string }
  | { type: 'session.forked'; childSessionId: string; afterSeq: number }
  | { type: 'session.branched'; fromSeq: number }
  | {
      type: 'session.shell_result'
      command: string
      output: string
      exitCode: number
      outcome: string
      share: boolean
    }
  | { type: 'agent.message_start' }
  | { type: 'agent.thinking_delta'; text: string }
  | { type: 'agent.message_delta'; text: string }
  | { type: 'agent.message_end'; content: ContentBlock[]; stopReason: string }
  | {
      type: 'agent.tool_use'
      toolUseId: string
      name: string
      input: unknown
      permission: ToolPermission
    }
  | { type: 'agent.tool_use_edited'; toolUseId: string; name: string; input: unknown }
  | { type: 'agent.tool_progress'; toolUseId: string; name: string; message: string }
  | {
      type: 'agent.tool_result'
      toolUseId: string
      name: string
      content: string
      isError: boolean
    }
  | { type: 'ui.surface'; surfaceId: string; slot: UiSlot; view: UiNode }
  | { type: 'ui.surface'; surfaceId: string; view: null }
  /** Files the agent wants on screen, opened in the editor as the event arrives. */
  | { type: 'ui.open_files'; files: OpenFileTarget[] }

/**
 * One file the agent asked grove to show. The path is absolute or relative to
 * the session's workspace root, and the line — when there is one — is 1-based.
 */
export interface OpenFileTarget {
  path: string
  line?: number
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
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
  status: SessionStatus
  stopReason?: IdleReason
  pendingApprovals: string[]
  lastSeq: number
  live: boolean
  /**
   * Whether a harness has taken a turn on this session.
   *
   * A conversation belongs to the runtime that produced it, so a started
   * session keeps the harness it started on; only the model stays open.
   */
  started: boolean
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
  label?: string
  input?: ToolInputView
  result?: ToolResultView
  languageFrom?: string
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

export interface FileMatch {
  path: string
  score: number
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
  /** Images attached to a message reach the model. */
  attachments: boolean
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
