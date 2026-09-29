// One session's run on switchboard.
//
// switchboard hands over ACP: session updates as they happen, permission
// requests to answer, and a result when a turn ends. The run puts the updates
// on grove's log as they are, routes a subagent's updates to that subagent's
// session, answers permission requests from grove's approval flow, and keeps
// the session's running totals. It knows nothing about any one harness; what
// differs between them is the profile it is started with.

import type {
  ContentBlock,
  Effort,
  HarnessEvent,
  HarnessId,
  HarnessSession,
  PermissionPolicy,
  PermissionReply,
  PromptResult,
  RequestPermissionRequest,
  SessionInit,
  SessionOptions,
  SessionUpdate,
  StopReason,
  ToolCallUpdate
} from '@neoworks/harness'
import type { AgentMode, IdleReason, ThinkingLevel, Usage } from '../../../shared/agents'
import type {
  ApprovalDecision,
  GroveTool,
  HarnessRun,
  HarnessRunOptions,
  PromptAttachment,
  SubagentIdentity
} from '../harness'
import { toolNameOf } from '../acpLog'
import { groveToolName, type BoundServer, type ToolBinding } from './mcpServer'
import type { SwitchboardHost } from './host'

/** What sets one kind of run apart: the harness it runs on and how it is configured. */
export interface RunProfile {
  harness: HarnessId
  /** The switchboard options a session of this kind starts with. */
  sessionOptions(options: HarnessRunOptions): SessionOptions
  /**
   * Tools this kind of run offers on top of grove's own. Those that ask before
   * they run are the ones that change something, and plan mode refuses them.
   */
  tools?(options: HarnessRunOptions): GroveTool[]
  /** Variables the harness is started with, for a model reached through another provider. */
  environment?(options: HarnessRunOptions): Promise<Record<string, string> | undefined>
}

/**
 * The parts of a session switchboard only offers on some harnesses, and only
 * from some versions on. Each is looked for before it is used, so a harness
 * that lacks one loses that feature rather than the run.
 */
interface LiveSession extends HarnessSession {
  steer?(content: string | ContentBlock[]): Promise<void>
  command?(name: string, args: string): PromiseLike<PromptResult>
  setModel?(model: string): Promise<void>
  setEffort?(effort: Effort): Promise<void>
  setPermissions?(policy: PermissionPolicy): Promise<void>
  dispose?(): Promise<void>
}

type ToolCallContent = NonNullable<ToolCallUpdate['content']>[number]

/** A tool call as the harness has reported it so far. */
interface TrackedCall {
  name: string
  input: unknown
  settled: boolean
}

// The blob scheme an image a tool returned is stored under, in place of its bytes.
export const BLOB_URI_SCHEME = 'grove-blob:'

export class SwitchboardRun implements HarnessRun {
  private session: LiveSession | null = null
  private bound: BoundServer | null = null
  private turn: PromiseLike<PromptResult> | null = null
  private calls = new Map<string, TrackedCall>()
  /** What grove's own tools added to their calls, kept through the harness's later reports. */
  private reported = new Map<string, ToolCallContent[]>()
  private usage: Usage
  private cost: number
  private contextUsed = 0
  private contextWindow = 0
  private mode: AgentMode

  constructor(
    private host: SwitchboardHost,
    private profile: RunProfile,
    private options: HarnessRunOptions
  ) {
    this.usage = { ...options.startingStats.usage }
    this.cost = options.startingStats.cost
    this.mode = options.permissionMode
  }

  get resumeKey(): string | null {
    if (!this.session) return this.options.resumeKey
    return this.session.id
  }

  /** Open the harness session, resuming the stored conversation when there is one. */
  async start(): Promise<void> {
    const switchboard = await this.host.switchboard()
    this.bound = await this.host.toolServer.bind(this.toolBinding())
    const init = await this.sessionInit(this.bound)
    let session: LiveSession
    if (this.options.resumeKey) {
      session = await switchboard.resumeSession(this.options.resumeKey, init)
    } else {
      session = await switchboard.createSession(init)
    }
    session.onEvent((event) => this.handle(event))
    this.session = session
  }

  prompt(text: string, attachments: PromptAttachment[] = []): Promise<void> {
    const session = this.requireSession()
    this.options.emit({ type: 'session.status_running' })
    this.follow(session.prompt(promptContent(text, attachments)))
    return Promise.resolve()
  }

  async steer(text: string): Promise<void> {
    const session = this.requireSession()
    if (!session.steer) throw new Error('This harness cannot take a message while it works.')
    await session.steer(text)
  }

  command(name: string, args: string): Promise<void> {
    const session = this.requireSession()
    if (!session.command) return this.prompt(commandText(name, args))
    this.options.emit({ type: 'session.status_running' })
    this.follow(session.command(name, args))
    return Promise.resolve()
  }

  async interrupt(): Promise<void> {
    await this.requireSession().cancel()
  }

  async setModel(_provider: string | null, model: string): Promise<void> {
    const session = this.requireSession()
    if (!session.setModel) throw new Error('This harness cannot change model mid-session.')
    await session.setModel(model)
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const session = this.requireSession()
    const effort = effortOf(level)
    if (!session.setEffort || !effort) return
    await session.setEffort(effort)
  }

  async setPermissionMode(mode: AgentMode): Promise<void> {
    const session = this.requireSession()
    this.mode = mode
    if (!session.setPermissions) return
    await session.setPermissions(permissionPolicyOf(mode))
  }

  async dispose(): Promise<void> {
    this.bound?.dispose()
    this.bound = null
    const session = this.session
    this.session = null
    if (!session) return
    if (session.dispose) {
      await session.dispose()
      return
    }
    await session.close()
  }

  // ── Setting up ──────────────────────────────────────────────────

  private async sessionInit(bound: BoundServer): Promise<SessionInit> {
    const init: SessionInit & { env?: Record<string, string> } = {
      harness: this.profile.harness,
      cwd: this.options.workspaceRoot,
      mcpServers: [bound.server],
      options: this.profile.sessionOptions(this.options),
      onPermission: (request) => this.answerPermission(request)
    }
    if (this.profile.environment) init.env = await this.profile.environment(this.options)
    return init
  }

  /** grove's tools as this session serves them to the harness. */
  private toolBinding(): ToolBinding {
    let profileTools: GroveTool[] = []
    if (this.profile.tools) profileTools = this.profile.tools(this.options)
    const tools = [...this.options.tools, ...profileTools]
    return {
      harnessSessionId: () => this.session?.id ?? '',
      tools: () => tools,
      context: {
        sessionId: this.options.sessionId,
        workspaceRoot: this.options.workspaceRoot,
        surface: (surfaceId, slot, view) =>
          this.options.emit({ type: 'ui.surface', surfaceId, slot, view } as never),
        show: (target) => this.options.emit({ type: 'ui.show', target }),
        shellOutput: this.options.shellOutput
      },
      confirm: (request) => this.options.confirm(request),
      callFor: (toolName, input) => this.callFor(toolName, input),
      refusal: (tool) => this.refusalOf(tool, profileTools),
      report: (toolCallId, update) => this.report(toolCallId, update)
    }
  }

  /** Put what a grove tool says about its call on the log, as an update to the call. */
  private report(toolCallId: string, update: Omit<ToolCallUpdate, 'toolCallId'>): void {
    if (update.content) this.reported.set(toolCallId, update.content)
    this.options.emit({
      type: 'update',
      update: { sessionUpdate: 'tool_call_update', ...update, toolCallId }
    })
  }

  /** Plan mode keeps the session to looking: the profile's tools that change things are off. */
  private refusalOf(tool: GroveTool, profileTools: GroveTool[]): string | null {
    if (this.mode !== 'plan') return null
    if (tool.policy !== 'ask' || !profileTools.includes(tool)) return null
    return `${tool.name} is not available in plan mode. Present the plan instead.`
  }

  private requireSession(): LiveSession {
    if (!this.session) throw new Error('The harness session is not open.')
    return this.session
  }

  // ── Turns ───────────────────────────────────────────────────────

  /** Settle the session once a turn the harness is running ends, however it ends. */
  private follow(turn: PromiseLike<PromptResult>): void {
    this.turn = turn
    turn.then(
      (result) => this.finishTurn(turn, result),
      (cause: unknown) => this.failTurn(turn, cause)
    )
  }

  private finishTurn(turn: PromiseLike<PromptResult>, result: PromptResult): void {
    if (this.turn === turn) this.turn = null
    this.addTurnUsage(result)
    const notice = stopNotice(result.stopReason)
    if (notice) this.options.emit({ type: 'session.notice', message: notice })
    this.options.emit({ type: 'session.status_idle', stopReason: idleReasonOf(result.stopReason) })
  }

  private failTurn(turn: PromiseLike<PromptResult>, cause: unknown): void {
    if (this.turn === turn) this.turn = null
    this.options.emit({ type: 'session.error', message: messageOf(cause) })
    this.options.emit({ type: 'session.status_idle', stopReason: 'error' })
  }

  // ── What the harness reports ────────────────────────────────────

  private handle(event: HarnessEvent): void {
    if (event.type === 'update') {
      this.absorbUpdate(event.update)
      return
    }
    const other = event as unknown as { type: string; sessionId?: string }
    // The harness left its conversation for a new one (`/clear`): the log says
    // so, and the new id is what the session resumes from now on.
    if (other.type === 'session_changed' && typeof other.sessionId === 'string') {
      this.options.emit({ type: 'session_changed', sessionId: other.sessionId })
    }
  }

  private absorbUpdate(update: SessionUpdate): void {
    if (update.sessionUpdate === 'usage_update') {
      this.contextUsed = update.used
      this.contextWindow = update.size
      this.reportStats()
      return
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.track(update)
    }
    const stored = this.withReportedContent(this.withStoredImages(update))
    const parent = parentToolCallOf(update)
    if (parent) {
      this.options.emitFrom(this.laneOf(parent), { type: 'update', update: stored })
      return
    }
    this.options.emit({ type: 'update', update: stored })
  }

  /** Remember what a call is and was asked to do, for approvals and subagent lanes. */
  private track(update: ToolCallUpdate): void {
    let call = this.calls.get(update.toolCallId)
    if (!call) {
      call = { name: '', input: {}, settled: false }
      this.calls.set(update.toolCallId, call)
    }
    const name = toolNameOf(update)
    if (name) call.name = name
    if (update.rawInput !== undefined) call.input = update.rawInput
    if (update.status === 'completed' || update.status === 'failed') call.settled = true
  }

  /** The unsettled call to a grove tool with this input, if the harness has reported one. */
  private callFor(toolName: string, input: unknown): { toolCallId: string; name: string } | null {
    const wanted = JSON.stringify(input)
    for (const [toolCallId, call] of this.calls) {
      if (call.settled || groveToolName(call.name) !== toolName) continue
      if (JSON.stringify(call.input) === wanted) return { toolCallId, name: call.name }
    }
    return null
  }

  /** The subagent a tool call started, named from what the call was asked. */
  private laneOf(toolCallId: string): SubagentIdentity {
    const call = this.calls.get(toolCallId)
    const input = asRecord(call?.input)
    let title = firstString(input, ['subagent_type', 'description'])
    if (!title) title = call?.name || 'Subagent'
    return {
      toolUseId: toolCallId,
      title,
      description: firstString(input, ['prompt', 'description'])
    }
  }

  /** The update with every image a tool returned moved into the session's blobs. */
  private withStoredImages(update: SessionUpdate): SessionUpdate {
    if (update.sessionUpdate !== 'tool_call_update' && update.sessionUpdate !== 'tool_call') {
      return update
    }
    if (!update.content?.some(isInlineImage)) return update
    const content = update.content.map((entry) => {
      if (!isInlineImage(entry)) return entry
      const image = (entry as { content: Extract<ContentBlock, { type: 'image' }> }).content
      const stored = this.options.storeImage({ mediaType: image.mimeType, data: image.data })
      return {
        ...entry,
        content: { ...image, data: '', uri: `${BLOB_URI_SCHEME}${stored.ref}` }
      }
    })
    return { ...update, content } as SessionUpdate
  }

  /**
   * The update with what grove's tool reported about the call ahead of the
   * harness's own content. ACP content replaces what came before, and the
   * harness knows only the tool's text result, so its report would drop the diff.
   */
  private withReportedContent(update: SessionUpdate): SessionUpdate {
    if (update.sessionUpdate !== 'tool_call_update' || !update.content) return update
    const reported = this.reported.get(update.toolCallId)
    if (!reported) return update
    if (update.status === 'completed' || update.status === 'failed') {
      this.reported.delete(update.toolCallId)
    }
    return { ...update, content: [...reported, ...update.content] }
  }

  // ── Permissions ─────────────────────────────────────────────────

  /**
   * Answer a harness asking before a tool call. grove's own tools hold their
   * calls themselves, so the harness is let through on those.
   */
  private async answerPermission(request: RequestPermissionRequest): Promise<PermissionReply> {
    const name = toolNameOf(request.toolCall)
    if (name && groveToolName(name)) return 'once'
    const decision = await this.options.confirm(request)
    return this.replyTo(decision)
  }

  private replyTo(decision: ApprovalDecision): PermissionReply {
    if (decision.result === 'deny') {
      // ACP carries no reason with a refusal, so the reason follows as a
      // message the agent reads before it carries on.
      if (decision.reason?.trim()) void this.steer(decision.reason).catch(() => {})
      return 'reject'
    }
    const outcome = decision.result === 'allow' ? 'once' : 'always'
    if (decision.input === undefined) return outcome
    return { outcome, updatedInput: decision.input } as unknown as PermissionReply
  }

  // ── Totals ──────────────────────────────────────────────────────

  private addTurnUsage(result: PromptResult): void {
    const turn = result.usage
    if (!turn) return
    this.usage = {
      inputTokens: this.usage.inputTokens + (turn.input ?? 0),
      outputTokens: this.usage.outputTokens + (turn.output ?? 0),
      cacheReadTokens: this.usage.cacheReadTokens + (turn.cacheRead ?? 0),
      cacheWriteTokens: this.usage.cacheWriteTokens + (turn.cacheWrite ?? 0)
    }
    if (typeof turn.costUsd === 'number') this.cost += turn.costUsd
    this.reportStats()
  }

  private reportStats(): void {
    this.options.stats({
      usage: this.usage,
      cost: this.cost,
      contextUsed: this.contextUsed,
      contextWindow: this.contextWindow
    })
  }
}

/** A prompt as ACP content: the text, then any images. */
function promptContent(text: string, attachments: PromptAttachment[]): ContentBlock[] {
  const content: ContentBlock[] = [{ type: 'text', text }]
  for (const attachment of attachments) {
    content.push({ type: 'image', mimeType: attachment.mediaType, data: attachment.data })
  }
  return content
}

function commandText(name: string, args: string): string {
  if (args.trim().length === 0) return `/${name}`
  return `/${name} ${args.trim()}`
}

/** A thinking level as switchboard's effort; `off` leaves the harness's own default. */
export function effortOf(level: ThinkingLevel): Effort | undefined {
  if (level === 'off') return undefined
  return level
}

/**
 * The switchboard policy a mode runs under. Only plan mode is left to the
 * harness, which withholds the tools that change anything; grove answers the
 * permissive modes itself, so the harness keeps asking and grove keeps a record.
 */
export function permissionPolicyOf(mode: AgentMode): PermissionPolicy {
  if (mode === 'plan') return 'read-only'
  return 'ask'
}

function idleReasonOf(stopReason: StopReason): IdleReason {
  if (stopReason === 'cancelled') return 'aborted'
  return 'end_turn'
}

/** What to tell the user about a turn that stopped short of finishing. */
function stopNotice(stopReason: StopReason): string | null {
  if (stopReason === 'max_tokens') return 'The reply hit the output token limit.'
  if (stopReason === 'max_turn_requests') return 'The turn hit its request or budget limit.'
  if (stopReason === 'refusal') return 'The model declined to continue.'
  return null
}

/** The tool call an update belongs to when a subagent produced it. */
export function parentToolCallOf(update: SessionUpdate): string | null {
  const meta = update._meta as
    | { claudeCode?: { parentToolUseId?: unknown }; neoworks?: { parentToolCallId?: unknown } }
    | null
    | undefined
  const neoworks = meta?.neoworks?.parentToolCallId
  if (typeof neoworks === 'string') return neoworks
  const claude = meta?.claudeCode?.parentToolUseId
  if (typeof claude === 'string') return claude
  return null
}

function isInlineImage(entry: NonNullable<ToolCallUpdate['content']>[number]): boolean {
  if (entry.type !== 'content') return false
  const block = (entry as { content: ContentBlock }).content
  if (block.type !== 'image') return false
  return block.data.length > 0
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Record<string, unknown>
}

function firstString(input: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = input[field]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
