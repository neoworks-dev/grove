// One session's run on switchboard.
//
// switchboard hands over ACP: session updates as they happen, permission
// requests to answer, and a result when a turn ends. The run puts the updates
// on grove's log as they are, routes a subagent's updates to that subagent's
// session, answers permission requests from grove's approval flow, and keeps
// the session's running totals. It knows nothing about any one harness; what
// differs between them is the profile it is started with.

import type {
  Capabilities,
  ContentBlock,
  Effort,
  HarnessEvent,
  HarnessId,
  HarnessSession,
  PermissionPolicy,
  PermissionReply,
  PromptResult,
  QuestionReply,
  QuestionRequest,
  RequestPermissionRequest,
  SessionInit,
  SessionOptions,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
  Usage as SwitchboardUsage
} from '@neoworks/harness'
import type { AgentMode, DeliverAs, IdleReason, ThinkingLevel, Usage } from '../../../shared/agents'
import type {
  ApprovalDecision,
  GroveTool,
  HarnessRun,
  HarnessRunOptions,
  PromptAttachment,
  SubagentIdentity
} from '../harness'
import { toolNameOf } from '../acpLog'
import { CALL_TOOL, dispatchedCall } from '../tools/toolSearchTools'
import { ASK_USER } from '../tools/questionTools'
import { reportedFastMode, requestFastMode, type ConfigurableSession } from './fastMode'
import { groveToolName, type BoundServer, type ToolBinding } from './mcpServer'
import type { SwitchboardHost } from './host'
import { TerminalRelay } from './terminalRelay'

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
  /**
   * Whether a tool's schema is given to the harness up front. One that is not
   * stays callable through `call_tool` once `tool_search` has loaded it. Every
   * tool is listed when the profile does not say.
   */
  listsUpFront?(tool: GroveTool): boolean
  /** Variables the harness is started with, for a model reached through another provider. */
  environment?(options: HarnessRunOptions): Promise<Record<string, string> | undefined>
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
  private session: HarnessSession | null = null
  private bound: BoundServer | null = null
  private turn: PromiseLike<PromptResult> | null = null
  private calls = new Map<string, TrackedCall>()
  /** What grove's own tools added to their calls, kept through the harness's later reports. */
  private reported = new Map<string, ToolCallContent[]>()
  /** Calls made through `call_tool`: the harness's name for it, and the tool it named once known. */
  private dispatched = new Map<string, { dispatcher: string; inner: string | null }>()
  private usage: Usage
  private cost: number
  private contextUsed = 0
  private contextWindow = 0
  private mode: AgentMode
  private terminals: TerminalRelay
  /** What the harness this run is on can do, once switchboard has said. */
  private capabilities: Capabilities | null = null

  constructor(
    private host: SwitchboardHost,
    private profile: RunProfile,
    private options: HarnessRunOptions
  ) {
    this.usage = { ...options.startingStats.usage }
    this.cost = options.startingStats.cost
    this.mode = options.permissionMode
    this.terminals = new TerminalRelay(options.shellOutput)
  }

  get resumeKey(): string | null {
    if (!this.session) return this.options.resumeKey
    return this.session.id
  }

  /**
   * Open the harness session: a copy of the stored conversation cut short when
   * the session was taken back to an earlier message, the stored conversation
   * when there is one, or a new one.
   */
  async start(): Promise<void> {
    const switchboard = await this.host.switchboard()
    const harnesses = await switchboard.listHarnesses()
    const info = harnesses.find((harness) => harness.id === this.profile.harness)
    if (info) this.capabilities = info.capabilities
    this.bound = await this.host.toolServer.bind(this.toolBinding())
    const init = await this.sessionInit(this.bound)
    const resumeKey = this.options.resumeKey
    const forkAt = this.options.forkAt
    let session: HarnessSession
    if (resumeKey && forkAt) {
      session = await switchboard.forkSession(resumeKey, init, { upToMessageId: forkAt })
    } else if (resumeKey) {
      session = await switchboard.resumeSession(resumeKey, init)
    } else {
      session = await switchboard.createSession(init)
    }
    session.onEvent((event) => this.handle(event))
    this.session = session
    if (this.options.fastMode) await this.startInFastMode()
  }

  /** Switches fast mode on for a session that was saved with it on; says in the transcript when it cannot. */
  private async startInFastMode(): Promise<void> {
    try {
      await this.setFastMode(true)
    } catch (cause) {
      this.options.emit({
        type: 'session.notice',
        message: `Fast mode was not turned on: ${messageOf(cause)}`
      })
    }
  }

  prompt(text: string, attachments: PromptAttachment[] = []): Promise<void> {
    const session = this.requireSession()
    this.options.emit({ type: 'session.status_running' })
    this.follow(session.prompt(promptContent(text, attachments)))
    return Promise.resolve()
  }

  /** Delivers into the running turn; images go along as ACP content, as with a prompt. */
  async steer(
    text: string,
    _deliverAs?: DeliverAs,
    attachments: PromptAttachment[] = []
  ): Promise<void> {
    if (attachments.length > 0) {
      await this.requireSession().steer(promptContent(text, attachments))
      return
    }
    await this.requireSession().steer(text)
  }

  command(name: string, args: string): Promise<void> {
    const session = this.requireSession()
    this.options.emit({ type: 'session.status_running' })
    this.follow(session.command(name, args))
    return Promise.resolve()
  }

  async interrupt(): Promise<void> {
    await this.requireSession().cancel()
  }

  async setModel(_provider: string | null, model: string): Promise<void> {
    await this.requireSession().setModel(model)
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const effort = effortOf(level)
    if (!effort) return
    await this.requireSession().setEffort(effort)
  }

  async setFastMode(enabled: boolean): Promise<void> {
    const session = this.requireSession() as unknown as ConfigurableSession
    await requestFastMode(session, enabled)
  }

  async setPermissionMode(mode: AgentMode): Promise<void> {
    this.mode = mode
    await this.requireSession().setPermissions(permissionPolicyOf(mode))
  }

  async dispose(): Promise<void> {
    this.bound?.dispose()
    this.bound = null
    const session = this.session
    this.session = null
    if (!session) return
    await session.dispose()
  }

  // ── Setting up ──────────────────────────────────────────────────

  private async sessionInit(bound: BoundServer): Promise<SessionInit> {
    const init: SessionInit = {
      harness: this.profile.harness,
      cwd: this.options.workspaceRoot,
      mcpServers: [bound.server],
      options: this.withPinnedPrompt(this.profile.sessionOptions(this.options)),
      onPermission: (request) => this.answerPermission(request),
      onQuestion: (request) => this.answerQuestion(request),
      usage: switchboardUsageOf(this.options.startingStats)
    }
    if (this.profile.environment) init.env = await this.profile.environment(this.options)
    return init
  }

  /**
   * The options with the system prompt the conversation started with. A harness
   * resuming takes the prompt from its options, not its transcript, so a fresh
   * conversation records the prompt it was given and a resumed one is handed
   * that back rather than one composed now.
   */
  private withPinnedPrompt(options: SessionOptions): SessionOptions {
    const recorded = this.options.recordedPrompt
    if (recorded && this.options.resumeKey) {
      return { ...options, systemPrompt: { ...recorded } }
    }
    if (options.systemPrompt) {
      this.options.emit({
        type: 'session.system_prompt',
        systemPrompt: { ...options.systemPrompt }
      })
    }
    return options
  }

  /** grove's tools as this session serves them to the harness. */
  private toolBinding(): ToolBinding {
    let profileTools: GroveTool[] = []
    if (this.profile.tools) profileTools = this.profile.tools(this.options)
    const tools = [...this.options.tools, ...profileTools]
    const listsUpFront = this.profile.listsUpFront
    let listed = tools
    if (listsUpFront) listed = tools.filter((tool) => listsUpFront(tool))
    return {
      harnessSessionId: () => this.session?.id ?? '',
      tools: () => tools,
      listed: () => listed,
      context: {
        tools: () => tools,
        sessionId: this.options.sessionId,
        workspaceRoot: this.options.workspaceRoot,
        surface: (surfaceId, slot, view) =>
          this.options.emit({ type: 'ui.surface', surfaceId, slot, view } as never),
        show: (target) => this.options.emit({ type: 'ui.show', target }),
        shellOutput: this.options.shellOutput,
        notify: (label, text) => this.options.notify(label, text)
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

  /**
   * Plan mode keeps the session to looking: the profile's tools that change
   * things are off. Asking the user is held for an answer too, but changes
   * nothing, so it stays.
   */
  private refusalOf(tool: GroveTool, profileTools: GroveTool[]): string | null {
    if (this.mode !== 'plan') return null
    if (tool.name === ASK_USER) return null
    if (tool.policy !== 'ask' || !profileTools.includes(tool)) return null
    return `${tool.name} is not available in plan mode. Present the plan instead.`
  }

  private requireSession(): HarnessSession {
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
    const notice = stopNotice(result.stopReason)
    if (notice && result.stopReason === 'refusal') {
      // The refused prompt stays in the conversation and gets every later one
      // refused too; marked, the notice offers to reword it instead.
      this.options.emit({ type: 'session.notice', message: notice, refusal: true })
    } else if (notice) {
      this.options.emit({ type: 'session.notice', message: notice })
    }
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
    if (event.type === 'usage') {
      this.absorbUsage(event)
      return
    }
    // The harness left its conversation for a new one (`/clear`): the log says
    // so, and the new id is what the session resumes from now on.
    if (event.type === 'session_changed') {
      this.options.emit({ type: 'session_changed', sessionId: event.sessionId })
    }
  }

  private absorbUpdate(update: SessionUpdate): void {
    // The context fill arrives again on the `usage` event that follows.
    if (update.sessionUpdate === 'usage_update') return
    if (update.sessionUpdate === 'config_option_update') this.noteFastMode(update.configOptions)
    let logged: SessionUpdate | null = update
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const unwrapped = this.unwrapped(update)
      this.track(unwrapped)
      logged = this.terminals.relay(unwrapped)
    }
    if (!logged) return
    const stored = this.withReportedContent(this.withStoredImages(logged))
    const parent = parentToolCallOf(update)
    if (parent) {
      this.options.emitFrom(this.laneOf(parent), { type: 'update', update: stored })
      return
    }
    this.options.emit({ type: 'update', update: stored })
  }

  /** Tells the session when the harness reports fast mode on or off. */
  private noteFastMode(configOptions: { id: string; currentValue?: unknown }[]): void {
    const enabled = reportedFastMode(configOptions)
    if (enabled === null) return
    this.options.fastModeReported?.(enabled)
  }

  /**
   * A call made through `call_tool` as a call to the tool it named, so the
   * transcript, approvals and display settings see that tool. Any other call
   * as it came.
   */
  private unwrapped<Update extends ToolCallUpdate>(update: Update): Update {
    const name = toolNameOf(update)
    if (name && groveToolName(name) === CALL_TOOL) {
      if (!this.dispatched.has(update.toolCallId)) {
        this.dispatched.set(update.toolCallId, { dispatcher: name, inner: null })
      }
    }
    const dispatch = this.dispatched.get(update.toolCallId)
    if (!dispatch) return update

    const unwrapped: Update = { ...update }
    const called = dispatchedCall(update.rawInput)
    if (update.rawInput !== undefined && called) {
      dispatch.inner = called.name
      unwrapped.rawInput = called.input
    }
    if (!dispatch.inner) return unwrapped
    const innerName = dispatch.dispatcher.slice(0, -CALL_TOOL.length) + dispatch.inner
    unwrapped.name = innerName
    if (update.title) unwrapped.title = dispatch.inner
    if (update._meta) unwrapped._meta = withToolName(update._meta, innerName)
    return unwrapped
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
      if (decision.reason?.trim()) this.tellAgent(decision.reason)
      return 'reject'
    }
    let outcome: 'once' | 'always' = 'always'
    if (decision.result === 'allow') outcome = 'once'
    if (decision.input === undefined) return outcome
    if (this.capabilities?.editedInput) return { outcome, updatedInput: decision.input }
    // A harness that runs a call only as it asked is told what the user
    // changed instead, and makes the call again.
    this.tellAgent(
      `The user changed that call before allowing it. Make it again with this input:\n${JSON.stringify(decision.input)}`
    )
    return 'reject'
  }

  /** Hand the agent a message in the turn it is running. */
  private tellAgent(text: string): void {
    void this.steer(text).catch(() => {})
  }

  /**
   * Put the agent's questions to the user. They are parked like an approval
   * of the call that asks them, and the answers come back as that call's
   * edited input, which is how the transcript already asks and answers.
   */
  private async answerQuestion(request: QuestionRequest): Promise<QuestionReply> {
    let name = this.calls.get(request.toolCallId)?.name
    if (!name) name = 'AskUserQuestion'
    const decision = await this.options.confirm({
      sessionId: this.requireSession().id,
      toolCall: {
        toolCallId: request.toolCallId,
        name,
        title: 'Question',
        kind: 'other',
        rawInput: { questions: request.questions }
      },
      options: [
        { optionId: 'answer', name: 'Answer', kind: 'allow_once' },
        { optionId: 'skip', name: 'Skip', kind: 'reject_once' }
      ]
    })
    if (decision.result === 'deny') return 'cancel'
    return { answers: answersOf(decision.input) }
  }

  // ── Totals ──────────────────────────────────────────────────────

  /**
   * The session's totals, exactly as switchboard keeps them: across turns, and
   * starting over when the conversation does (`/clear`), when it sends empty
   * totals and no context. Grove only takes them as given.
   */
  private absorbUsage(event: Extract<HarnessEvent, { type: 'usage' }>): void {
    const total = event.total
    this.usage = {
      inputTokens: countOf(total.input),
      outputTokens: countOf(total.output),
      cacheReadTokens: countOf(total.cacheRead),
      cacheWriteTokens: countOf(total.cacheWrite)
    }
    this.cost = countOf(total.costUsd)
    if (event.context) {
      this.contextUsed = event.context.used
      this.contextWindow = event.context.size
    } else {
      // Nothing in context yet: a fresh conversation. The window keeps its size.
      this.contextUsed = 0
    }
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
/** A call's harness metadata naming another tool, for Claude Code's own record of the name. */
function withToolName(meta: Record<string, unknown>, toolName: string): Record<string, unknown> {
  const claudeCode = meta.claudeCode
  if (!claudeCode || typeof claudeCode !== 'object') return meta
  return { ...meta, claudeCode: { ...(claudeCode as Record<string, unknown>), toolName } }
}

function promptContent(text: string, attachments: PromptAttachment[]): ContentBlock[] {
  const content: ContentBlock[] = [{ type: 'text', text }]
  for (const attachment of attachments) {
    content.push({ type: 'image', mimeType: attachment.mediaType, data: attachment.data })
  }
  return content
}

/** A session's totals as switchboard seeds a session with them. */
function switchboardUsageOf(stats: HarnessRunOptions['startingStats']): SwitchboardUsage {
  return {
    input: stats.usage.inputTokens,
    output: stats.usage.outputTokens,
    cacheRead: stats.usage.cacheReadTokens,
    cacheWrite: stats.usage.cacheWriteTokens,
    costUsd: stats.cost
  }
}

function countOf(value: number | undefined): number {
  if (value === undefined) return 0
  return value
}

/** The answers in the input a question call was allowed with. */
function answersOf(input: unknown): Record<string, string> {
  const answers = asRecord(asRecord(input).answers)
  const found: Record<string, string> = {}
  for (const [question, answer] of Object.entries(answers)) {
    if (typeof answer === 'string') found[question] = answer
  }
  return found
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
