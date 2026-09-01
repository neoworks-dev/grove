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
  | { type: 'app.message'; label: string; text: string; deliverAs?: DeliverAs }
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
  labels: Record<string, string>
  createdAt: string
  updatedAt: string
  status: SessionStatus
  stopReason?: IdleReason
  pendingApprovals: string[]
  lastSeq: number
  live: boolean
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
}

export interface SessionUpdate {
  title?: string
  harness?: string
  provider?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  activeTools?: string[] | null
  autoApproveTools?: string[]
}

export interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  contextWindow?: number
}

export interface ModelInfo {
  id: string
  provider: string
  label?: string
  contextWindow?: number
  pricing?: ModelPricing
}

export interface ProviderModels {
  provider: string
  models: ModelInfo[]
}

export type ToolInputView = 'hidden' | 'json' | 'code' | 'command' | 'diff'

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
}

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
  providers: ProviderModels[]
  default: { provider: string; model: string } | null
}
