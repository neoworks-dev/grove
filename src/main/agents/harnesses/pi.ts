// pi, as a grove harness.
//
// pi is the only one of the three that runs entirely in grove's own process:
// `createAgentSession` returns a session object grove subscribes to, so events
// arrive as function calls rather than over a pipe. Tool approvals come from an
// inline extension listening on `tool_call`, which pi lets a handler block.

import type { Context } from '@neoworks/extension-system'
import type {
  AgentSession,
  AgentSessionEvent,
  DefaultResourceLoader,
  ExtensionAPI,
  ModelRuntime,
  SessionStats as PiSessionStats,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type {
  CommandInfo,
  ModelEntry,
  ModelPricing,
  ModelRoute,
  ServerEventBody,
  ThinkingLevel,
  ToolInfo,
  ToolPolicy
} from '../../../shared/agents'
import type {
  GroveTool,
  HarnessDescriptor,
  HarnessOffering,
  HarnessRun,
  HarnessRunOptions,
  PromptAttachment,
  ToolIntent
} from '../harness'
import { jsonSchemaToTypebox } from './typeboxSchema'

const HARNESS_ID = 'pi'

/**
 * pi's commands as grove runs them.
 *
 * pi's own list lives behind a module the package does not export, and each of
 * these is carried out by grove against the session API rather than by pi, so
 * what they say is grove's to write. Everything not named here is handed to pi
 * to dispatch — a prompt template, a skill, a command an extension registered.
 */
const SUPPORTED_BUILTINS: CommandInfo[] = [
  { name: 'new', description: 'Leave this conversation and start an empty one', kind: 'builtin' },
  {
    name: 'compact',
    description: 'Summarise the conversation so far and carry on from the summary',
    argumentHint: '<instructions>',
    kind: 'builtin'
  },
  {
    name: 'session',
    description: 'Show token use, cost and context for this session',
    kind: 'builtin'
  },
  { name: 'name', description: 'Name the session', argumentHint: '<name>', kind: 'builtin' }
]

class PiRun implements HarnessRun {
  resumeKey: string | null
  private session: AgentSession | null = null
  private loader: DefaultResourceLoader | null = null
  private modelRuntime: ModelRuntime | null = null
  private unsubscribe: (() => void) | null = null
  private policies: Map<string, ToolPolicy>
  // Set when a message came back as a failed request, so the turn can end saying so.
  private turnFailed = false
  // Counted so a command can tell whether what it sent started a turn at all.
  private turnsEnded = 0

  constructor(
    private options: HarnessRunOptions,
    policies: Map<string, ToolPolicy>
  ) {
    this.resumeKey = options.resumeKey
    this.policies = policies
  }

  /** Load pi's resources, open the session and start following its events. */
  async start(): Promise<void> {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
    this.modelRuntime = await ModelRuntime.create()
    this.loader = await this.loadResources()
    await this.open(this.resumeKey)
  }

  /**
   * pi's resources for this worktree, with grove's context appended to whatever
   * system prompt they build.
   *
   * Appended rather than set: `appendSystemPrompt` on its own would take the
   * place of the user's own append file, and grove being in the session is no
   * reason for their instructions to stop applying.
   */
  private async loadResources(): Promise<DefaultResourceLoader> {
    const { DefaultResourceLoader, getAgentDir } = await import('@earendil-works/pi-coding-agent')
    const loader = new DefaultResourceLoader({
      cwd: this.options.workspaceRoot,
      agentDir: getAgentDir(),
      extensionFactories: [{ name: 'grove-approvals', factory: (pi) => this.bindApprovals(pi) }],
      appendSystemPromptOverride: (base) => this.withGroveContext(base)
    })
    await loader.reload()
    return loader
  }

  private withGroveContext(base: string[]): string[] {
    const context = this.options.systemPrompt
    if (!context) return base
    return [...base, context]
  }

  /** Open a pi session: the run's own conversation when there is one, else a new one. */
  private async open(resumeKey: string | null): Promise<void> {
    const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent')
    const loader = this.loader
    const modelRuntime = this.modelRuntime
    if (!loader || !modelRuntime) throw new Error('the pi harness was not started')

    const created = await createAgentSession({
      cwd: this.options.workspaceRoot,
      model: this.modelFor(modelRuntime),
      thinkingLevel: this.options.thinkingLevel,
      modelRuntime,
      resourceLoader: loader,
      customTools: this.options.tools.map((definition) => this.wrapTool(definition)),
      tools: this.options.activeTools ?? undefined,
      sessionManager: resumeKey
        ? SessionManager.open(resumeKey)
        : SessionManager.create(this.options.workspaceRoot)
    })

    this.session = created.session
    if (created.session.sessionFile) this.resumeKey = created.session.sessionFile
    else this.resumeKey = resumeKey
    this.unsubscribe = created.session.subscribe((event) => this.handle(event))
  }

  async prompt(text: string, attachments: PromptAttachment[] = []): Promise<void> {
    const session = this.session
    if (!session) throw new Error('the pi harness is not running')
    this.options.emit({ type: 'session.status_running' })
    if (attachments.length === 0) {
      await session.prompt(text)
      return
    }
    await session.prompt(text, { images: attachments.map(imageOf) })
  }

  async steer(text: string, deliverAs: 'steer' | 'followUp'): Promise<void> {
    if (!this.session) return
    if (deliverAs === 'steer') await this.session.steer(text)
    else await this.session.followUp(text)
  }

  async interrupt(): Promise<void> {
    await this.session?.abort()
  }

  // ── Commands ────────────────────────────────────────────────────

  /**
   * Run a slash command.
   *
   * pi's own commands are its terminal's, not the session's, so the ones grove
   * can honour are carried out here against the session API. Anything else is
   * sent to pi as the line the user typed, which is how pi dispatches an
   * extension command and expands a skill or a prompt template.
   */
  async command(name: string, args: string): Promise<void> {
    const session = this.session
    if (!session) throw new Error('the pi harness is not running')
    // `clear` is not pi's name for it, but it is what every other harness calls
    // the same thing, and it is what a user who has used one of them types.
    if (name === 'new' || name === 'clear') return this.startFresh()
    if (name === 'compact') return this.compact(session, args)
    if (name === 'session') return this.reportSessionStats(session)
    if (name === 'name') return this.nameSession(session, args)
    return this.dispatch(session, name, args)
  }

  /** Leave the conversation behind and open an empty one, as pi's `/new` does. */
  private async startFresh(): Promise<void> {
    this.closeSession()
    await this.open(null)
    this.options.emit({ type: 'session.cleared' })
  }

  /** Summarise the conversation so far and carry on from the summary. */
  private async compact(session: AgentSession, instructions: string): Promise<void> {
    const trimmed = instructions.trim()
    if (trimmed.length === 0) {
      this.noticeCompaction(await session.compact())
      return
    }
    this.noticeCompaction(await session.compact(trimmed))
  }

  private noticeCompaction(result: { tokensBefore: number }): void {
    this.options.emit({
      type: 'session.notice',
      message: `Context compacted: ${result.tokensBefore} tokens summarised.`
    })
    this.reportUsage()
  }

  private reportSessionStats(session: AgentSession): void {
    this.options.emit({
      type: 'session.command_output',
      text: sessionSummary(session.getSessionStats())
    })
    this.reportUsage()
  }

  private nameSession(session: AgentSession, args: string): void {
    const name = args.trim()
    if (name.length === 0) {
      this.options.emit({
        type: 'session.notice',
        message: '/name takes the name to give the session.'
      })
      return
    }
    session.setSessionName(name)
    this.options.emit({ type: 'session.notice', message: `Session named "${name}".` })
  }

  /**
   * Hand the line to pi and let it decide what it was.
   *
   * Only some of what pi dispatches starts a turn — a prompt template does, a
   * command an extension registered usually does not — so the session is put
   * back to idle when nothing ran, rather than left saying it is working.
   */
  private async dispatch(session: AgentSession, name: string, args: string): Promise<void> {
    const endedBefore = this.turnsEnded
    this.options.emit({ type: 'session.status_running' })
    await session.prompt(commandLine(name, args), { expandPromptTemplates: true })
    if (this.turnsEnded !== endedBefore) return
    this.options.emit({ type: 'session.status_idle', stopReason: 'end_turn' })
  }

  async setModel(provider: string | null, model: string): Promise<void> {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
    const runtime = await ModelRuntime.create()
    const resolved = provider ? runtime.getModel(provider, model) : undefined
    if (resolved) await this.session?.setModel(resolved)
  }

  setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.session?.setThinkingLevel(level)
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    this.closeSession()
    return Promise.resolve()
  }

  private closeSession(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.session?.dispose()
    this.session = null
  }

  /**
   * What the session has spent so far.
   *
   * pi keeps running totals rather than reporting per-turn usage, so the whole
   * of it is handed over each time and grove stores the latest.
   */
  private reportUsage(): void {
    const session = this.session
    if (!session) return
    const stats = session.getSessionStats()
    let contextWindow = 0
    if (stats.contextUsage) contextWindow = stats.contextUsage.contextWindow
    this.options.stats({
      usage: {
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheReadTokens: stats.tokens.cacheRead,
        cacheWriteTokens: stats.tokens.cacheWrite
      },
      cost: stats.cost,
      contextWindow
    })
  }

  // ── Wiring ──────────────────────────────────────────────────────

  /**
   * The model to start with, or nothing — pi then restores the session's own
   * model, falls back to the configured default, and finally to whatever is
   * authenticated.
   */
  private modelFor(runtime: ModelRuntime): PiSelectedModel {
    const provider = this.options.provider
    const model = this.options.model
    if (!provider || !model) return undefined
    return runtime.getModel(provider, model)
  }

  /**
   * pi's `tool_call` event fires before a tool runs and a handler can block it,
   * which is exactly the gate grove's review flow needs. Tools grove does not
   * gate fall straight through.
   */
  private bindApprovals(pi: ExtensionAPI): void {
    pi.on('tool_call', async (event) => {
      if (this.policyFor(event.toolName) !== 'ask') return undefined
      const decision = await this.options.confirm({
        toolUseId: event.toolCallId,
        name: event.toolName,
        input: (event.input ?? {}) as Record<string, unknown>
      })
      if (decision.result !== 'deny') return undefined
      return { block: true, reason: decision.reason ?? 'denied by the user' }
    })
  }

  private policyFor(toolName: string): ToolPolicy {
    return this.policies.get(toolName) ?? 'allow'
  }

  private wrapTool(definition: GroveTool): ToolDefinition {
    return {
      name: definition.name,
      label: definition.summary,
      description: definition.description,
      parameters: jsonSchemaToTypebox(definition.inputSchema),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const result = await definition.execute(params, {
          sessionId: this.options.sessionId,
          workspaceRoot: this.options.workspaceRoot,
          surface: (surfaceId, slot, view) =>
            this.options.emit({ type: 'ui.surface', surfaceId, slot, view } as ServerEventBody),
          openFiles: (files) => this.options.emit({ type: 'ui.open_files', files })
        })
        return { content: [{ type: 'text', text: result.content }], isError: result.isError }
      }
    } as unknown as ToolDefinition
  }

  // ── Events ──────────────────────────────────────────────────────

  private handle(event: AgentSessionEvent): void {
    if (event.type === 'message_start') {
      this.options.emit({ type: 'agent.message_start' })
      return
    }
    if (event.type === 'message_update') {
      this.handleDelta(event.assistantMessageEvent)
      return
    }
    if (event.type === 'tool_execution_start') {
      this.handleToolStart(event.toolCallId, event.toolName, event.args)
      return
    }
    if (event.type === 'tool_execution_end') {
      this.options.emit({
        type: 'agent.tool_result',
        toolUseId: event.toolCallId,
        name: event.toolName,
        content: resultText(event.result),
        isError: event.isError
      })
      return
    }
    if (event.type === 'message_end') {
      this.handleMessageEnd(event.message)
      return
    }
    if (event.type === 'agent_end') {
      this.endTurn()
    }
  }

  /** A turn that ended on a failed request must not read as one that answered. */
  private endTurn(): void {
    const failed = this.turnFailed
    this.turnFailed = false
    this.turnsEnded += 1
    this.reportUsage()
    if (failed) {
      this.options.emit({ type: 'session.status_idle', stopReason: 'error' })
      return
    }
    this.options.emit({ type: 'session.status_idle', stopReason: 'end_turn' })
  }

  /**
   * The finished message, as the blocks it was made of.
   *
   * pi streams its answer as deltas and closes the message with the whole of it.
   * Reporting the close as well is what gives grove an answer it can hand on —
   * the review flow and the agent hand-off both read closed messages, and a
   * delta stream alone leaves them with nothing to quote.
   */
  private handleMessageEnd(message: unknown): void {
    const failure = failureOf(message)
    if (failure) {
      this.turnFailed = true
      this.options.emit({ type: 'session.error', message: failure })
      return
    }
    const text = assistantTextOf(message)
    if (!text) return
    this.options.emit({
      type: 'agent.message_end',
      content: [{ type: 'text', text }],
      stopReason: 'end_turn'
    })
  }

  /**
   * One streamed fragment.
   *
   * pi names its stream events for its own provider layer rather than for grove,
   * and the names have changed between releases, so what counts is that the
   * event carries a delta and whether it is reasoning or answer.
   */
  private handleDelta(assistantEvent: { type: string; delta?: string }): void {
    const delta = assistantEvent.delta
    if (typeof delta !== 'string' || delta.length === 0) return
    if (assistantEvent.type.includes('thinking') || assistantEvent.type.includes('reasoning')) {
      this.options.emit({ type: 'agent.thinking_delta', text: delta })
      return
    }
    this.options.emit({ type: 'agent.message_delta', text: delta })
  }

  /**
   * Tools grove gates are announced by the approval it raises, so reporting them
   * here as well would show the call twice — once ungated.
   */
  private handleToolStart(toolCallId: string, toolName: string, args: unknown): void {
    if (this.policyFor(toolName) === 'ask') return
    this.options.emit({
      type: 'agent.tool_use',
      toolUseId: toolCallId,
      name: toolName,
      input: args,
      permission: 'allow'
    })
  }
}

/** One of grove's attachments, as pi takes an image. */
function imageOf(attachment: PromptAttachment): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data: attachment.data, mimeType: attachment.mediaType }
}

/** The line the user would have typed, for pi to dispatch. */
export function commandLine(name: string, args: string): string {
  const trimmed = args.trim()
  if (trimmed.length === 0) return `/${name}`
  return `/${name} ${trimmed}`
}

/** What `/session` prints. */
function sessionSummary(stats: PiSessionStats): string {
  const lines = [
    `messages: ${stats.userMessages} from you, ${stats.assistantMessages} back, ${stats.toolCalls} tool calls`,
    `tokens: ${stats.tokens.input} in, ${stats.tokens.output} out, ${stats.tokens.cacheRead} cache read, ${stats.tokens.cacheWrite} cache write`,
    `cost: $${stats.cost.toFixed(4)}`
  ]
  if (stats.contextUsage && stats.contextUsage.tokens !== null) {
    lines.push(
      `context: ${stats.contextUsage.tokens} of ${stats.contextUsage.contextWindow} tokens used`
    )
  }
  if (stats.sessionFile) lines.push(`session: ${stats.sessionFile}`)
  return lines.join('\n')
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  const content = (result as { content?: unknown })?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(blockText).join('')
}

function blockText(block: unknown): string {
  const typed = block as { type?: string; text?: string }
  if (typed.type !== 'text' || typed.text === undefined) return ''
  return typed.text
}

/**
 * What one of pi's write tools would leave on disk. `write` replaces the file;
 * `edit` applies exact-match replacements in order, each against the text the
 * previous one produced.
 */
export function proposedContent(
  toolName: string,
  input: Record<string, unknown>,
  original: string
): string | null {
  if (toolName === 'write') return typeof input.content === 'string' ? input.content : null
  if (toolName !== 'edit' || !Array.isArray(input.edits)) return null

  let text = original
  for (const entry of input.edits as Record<string, unknown>[]) {
    if (typeof entry.oldText !== 'string' || typeof entry.newText !== 'string') continue
    if (entry.oldText.length === 0) continue
    text = text.replace(entry.oldText, entry.newText)
  }
  return text
}

/**
 * Why a message failed, or nothing when it did not.
 *
 * pi reports a failed provider request as an assistant message that stopped on
 * `error` and carries the reason — an expired token, a model the account cannot
 * use. Without this the run simply went quiet: an empty answer, an idle session
 * and nothing anywhere saying why.
 */
function failureOf(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const record = message as { stopReason?: unknown; errorMessage?: unknown }
  if (record.stopReason !== 'error') return null
  if (typeof record.errorMessage === 'string' && record.errorMessage.length > 0) {
    return record.errorMessage
  }
  return 'the runtime ended the turn with an error'
}

/**
 * The assistant text of one pi message.
 *
 * pi's message type is not published, and its content has been both a string and
 * a list of blocks, so both are read and anything else is treated as having no
 * text rather than as an error.
 */
function assistantTextOf(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const record = message as { role?: unknown; content?: unknown }
  if (record.role !== 'assistant') return ''
  if (typeof record.content === 'string') return record.content.trim()
  if (!Array.isArray(record.content)) return ''

  const parts: string[] = []
  for (const block of record.content) {
    if (typeof block === 'string') parts.push(block)
    if (typeof block !== 'object' || block === null) continue
    const entry = block as { type?: unknown; text?: unknown }
    if (entry.type === 'text' && typeof entry.text === 'string') parts.push(entry.text)
  }
  return parts.join('').trim()
}

/** A model pi can be started on; `undefined` lets pi choose for itself. */
type PiSelectedModel = ReturnType<ModelRuntime['getModel']>

/** The review header the agent wrote, if it wrote one. */
function summaryOf(input: Record<string, unknown>): string {
  if (typeof input.summary !== 'string') return ''
  return input.summary
}

/** Everything pi can offer, plus the policy grove applies to each tool. */
async function loadOffering(): Promise<HarnessOffering> {
  const { DefaultResourceLoader, ModelRuntime, SettingsManager, getAgentDir } =
    await import('@earendil-works/pi-coding-agent')

  const modelRuntime = await ModelRuntime.create()
  const available = await modelRuntime.getAvailable()
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir() })
  await loader.reload()
  const settings = SettingsManager.create(process.cwd(), getAgentDir())

  const prompts: CommandInfo[] = loader.getPrompts().prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description ?? '',
    kind: 'prompt'
  }))

  return {
    tools: await toolInfos(),
    // A command an extension registered is only known once a session has one
    // loaded, so it is not offered here — typed out it still reaches pi.
    commands: [...SUPPORTED_BUILTINS, ...prompts],
    skills: loader.getSkills().skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath
    })),
    models: modelsOf(available),
    default: defaultModelOf(available, settings)
  }
}

/**
 * pi's tools, described by pi.
 *
 * The tools are built here only to be read: name, description and parameter
 * schema are what the composer and the approval card show, and asking pi for
 * them beats a list in grove that goes stale the next time pi ships one.
 */
async function toolInfos(): Promise<ToolInfo[]> {
  const policies = await builtinPolicies()
  const { createCodingTools, createReadOnlyTools } = await import('@earendil-works/pi-coding-agent')
  const described = new Map<string, ToolInfo>()

  for (const tool of [...createReadOnlyTools(process.cwd()), ...createCodingTools(process.cwd())]) {
    const policy = policies.get(tool.name)
    if (policy === undefined) continue
    described.set(tool.name, {
      name: tool.name,
      description: tool.description,
      policy,
      parallelSafe: policy === 'allow',
      inputSchema: tool.parameters as Record<string, unknown>
    })
  }
  return [...described.values()]
}

/**
 * How grove treats each of pi's own tools.
 *
 * pi's read-only set is the allow-list: everything in it answers a question,
 * and everything outside it — bash, edit, write, and whatever pi adds next —
 * changes something and is held for a decision.
 */
export async function builtinPolicies(): Promise<Map<string, ToolPolicy>> {
  const { createCodingTools, createReadOnlyTools } = await import('@earendil-works/pi-coding-agent')
  const policies = new Map<string, ToolPolicy>()
  for (const tool of createCodingTools(process.cwd())) policies.set(tool.name, 'ask')
  for (const tool of createReadOnlyTools(process.cwd())) policies.set(tool.name, 'allow')
  return policies
}

/** The part of pi's settings grove reads: which model it was told to prefer. */
interface PiSettings {
  getDefaultProvider(): string | undefined
  getDefaultModel(): string | undefined
}

interface PiModel {
  id: string
  name: string
  provider: string
  contextWindow: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

/**
 * pi's models, grouped by the model rather than by who sells it.
 *
 * pi keys a model the same way whichever provider serves it, so the id is the
 * grouping — one entry for `glm-5.2`, with a route for each provider pi has
 * credentials for. Everything it reports is already credentialed, which is why
 * no route here asks for a key.
 */
function modelsOf(models: readonly unknown[]): ModelEntry[] {
  const byModel = new Map<string, ModelEntry>()
  for (const entry of models as PiModel[]) {
    const route: ModelRoute = {
      provider: entry.provider,
      id: entry.id,
      contextWindow: entry.contextWindow,
      pricing: pricingOf(entry.cost),
      native: true
    }
    const existing = byModel.get(entry.id)
    if (existing) {
      existing.routes.push(route)
      continue
    }
    byModel.set(entry.id, { key: entry.id, label: entry.name || entry.id, routes: [route] })
  }
  return [...byModel.values()]
}

/** pi reports costs per million tokens, with any field it does not know absent. */
function pricingOf(cost: PiModel['cost']): ModelPricing | undefined {
  if (!cost || cost.input === undefined || cost.output === undefined) return undefined
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0
  }
}

/**
 * What a new pi session should open on.
 *
 * pi's own configured default first — that is the model the user chose for pi,
 * and starting somewhere else because it happens to sort first in the runtime's
 * list is how a session ends up on a model nobody asked for. Whatever is
 * available stands in when there is no default, or when it names a model this
 * install cannot reach.
 */
function defaultModelOf(
  models: readonly unknown[],
  settings: PiSettings
): { provider: string; model: string } | null {
  const available = models as PiModel[]
  const configured = configuredModel(available, settings)
  if (configured) return configured

  const first = available[0]
  if (!first) return null
  return { provider: first.provider, model: first.id }
}

/** pi's configured default, when this install can actually run it. */
function configuredModel(
  available: PiModel[],
  settings: PiSettings
): { provider: string; model: string } | null {
  const model = settings.getDefaultModel()
  if (!model) return null
  const provider = settings.getDefaultProvider()

  const match = available.find((entry) => {
    if (entry.id !== model) return false
    return !provider || entry.provider === provider
  })
  if (!match) return null
  return { provider: match.provider, model: match.id }
}

function createPiHarness(): HarnessDescriptor {
  return {
    id: HARNESS_ID,
    label: 'pi',
    description: 'The pi coding agent, running in process with grove.',
    icon: 'grove:pi',
    capabilities: {
      approvals: true,
      interrupt: true,
      liveModelSwitch: true,
      thinking: true,
      steering: true,
      groveTools: true,
      attachments: true
    },

    async probe() {
      try {
        const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
        const runtime = await ModelRuntime.create()
        const available = await runtime.getAvailable()
        if (available.length > 0) return { available: true, detail: null }
        return { available: false, detail: 'no pi model has credentials — run `pi` and log in' }
      } catch (cause) {
        return { available: false, detail: (cause as Error).message }
      }
    },

    offering: () => loadOffering(),

    async start(options: HarnessRunOptions) {
      // Built per run: a policy is the session's, and a map shared by the
      // descriptor would carry one session's tools into the next one.
      const policies = await builtinPolicies()
      for (const tool of options.tools) policies.set(tool.name, tool.policy)
      const run = new PiRun(options, policies)
      await run.start()
      return run
    },

    intentOf(name, input) {
      if (name === 'request_review') return { kind: 'review', summary: summaryOf(input) }
      if (name !== 'write' && name !== 'edit') return null
      if (typeof input.path !== 'string') return null
      return {
        kind: 'write',
        path: input.path,
        apply: (original) => proposedContent(name, input, original)
      } satisfies ToolIntent
    }
  }
}

export const piHarness = {
  name: 'main/harness/pi',
  inject: ['harnesses'],

  apply(ctx: Context): void {
    ctx.effect(() => ctx.harnesses.register(createPiHarness()), 'harness:pi')
  }
}
