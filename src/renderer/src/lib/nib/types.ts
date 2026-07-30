// Vendored from nib (web/src/renderer/lib/types.ts), reformatted to grove's style.
// Unchanged otherwise — re-vendor by copying the file over and running prettier.
/**
 * The nib wire protocol, as this renderer sees it.
 *
 * Mirrors `src/core/events.ts` in the server. Kept as a hand-written copy so the frontend builds
 * and type-checks without importing server code.
 */

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

export type UserContentBlock = TextBlock | ImageBlock

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
 * Extension-contributed UI.
 *
 * An extension describes what it wants shown; deciding what that looks like is this renderer's
 * job, and a terminal client's answer will be a different one. Kinds this app does not implement
 * fall back to `fallbackText`, which is what lets the vocabulary grow without breaking us.
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

export type SessionEvent = EventBody & EventEnvelope

/** Every event name the server frames as `event: <type>`, so the stream can listen for each. */
export const EVENT_TYPES: EventBody['type'][] = [
  'user.message',
  'user.tool_confirmation',
  'user.interrupt',
  'user.tool_result',
  'user.command',
  'user.compact',
  'user.unqueue',
  'user.branch',
  'user.shell',
  'session.status_running',
  'session.status_idle',
  'session.status_terminated',
  'session.error',
  'session.notice',
  'session.info_changed',
  'session.compacted',
  'session.forked',
  'session.branched',
  'session.shell_result',
  'agent.message_start',
  'agent.thinking_delta',
  'agent.message_delta',
  'agent.message_end',
  'agent.tool_use',
  'agent.tool_use_edited',
  'agent.tool_progress',
  'agent.tool_result',
  'ui.surface'
]

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

export interface SessionSnapshot {
  id: string
  title: string
  workspaceRoot: string
  provider: string
  model: string
  thinkingLevel: ThinkingLevel
  activeTools: string[] | null
  autoApproveTools: string[]
  labels: Record<string, string>
  parentSessionId?: string
  forkedAfterSeq?: number
  createdAt: string
  updatedAt: string
  status: SessionStatus
  stopReason?: IdleReason
  pendingApprovals: string[]
  messageCount: number
  lastSeq: number
  usage: Usage
  cost: number
  context: ContextUsage
  queued: QueuedMessage[]
}

/**
 * A row from `GET /v1/sessions`: stored metadata, plus live status for sessions the server
 * already has in memory. `live: false` means nothing is running and nothing was loaded to answer.
 */
export type SessionMeta = Omit<
  SessionSnapshot,
  'messageCount' | 'usage' | 'cost' | 'context' | 'queued'
> & { live: boolean }

export interface CreateSessionOptions {
  workspace?: string
  title?: string
  provider?: string
  model?: string
  systemPrompt?: string
  appendSystemPrompt?: string
  maxTokens?: number
  thinkingLevel?: ThinkingLevel
  activeTools?: string[]
}

export interface SessionUpdate {
  title?: string
  provider?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  activeTools?: string[] | null
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
  contextWindow?: number
  pricing?: ModelPricing
}

export interface ProviderModels {
  provider: string
  models: ModelInfo[]
}

export type ToolInputView = 'hidden' | 'json' | 'code' | 'command' | 'diff'

export type ToolResultView = 'hidden' | 'text' | 'list' | 'file' | 'markdown' | 'code'

/** How a tool wants its call rendered. Intent only — the mapping to widgets is ours. */
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

export interface TreePoint {
  seq: number
  text: string
  label?: string
}

export interface AbandonedBranch {
  fromSeq: number
  /** Branch to this seq to put the branch back in play. */
  headSeq: number
  points: TreePoint[]
}

export interface SessionTree {
  parent: { sessionId: string; afterSeq: number } | null
  forks: Array<{ sessionId: string; title: string; afterSeq: number }>
  /** The seq the conversation currently continues from. */
  head: number
  active: TreePoint[]
  abandoned: AbandonedBranch[]
}
