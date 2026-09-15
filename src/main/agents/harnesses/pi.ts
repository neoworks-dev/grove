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
  ExtensionAPI,
  ModelRuntime,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type {
  ProviderModels,
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
  ToolIntent
} from '../harness'
import { jsonSchemaToTypebox } from './typeboxSchema'

const HARNESS_ID = 'pi'

// pi's built-in tools and how grove treats each one. Anything that changes the
// working tree is held for a decision; reading is not worth a prompt.
const BUILTIN_POLICIES: Record<string, ToolPolicy> = {
  read: 'allow',
  grep: 'allow',
  find: 'allow',
  ls: 'allow',
  bash: 'ask',
  powershell: 'ask',
  edit: 'ask',
  write: 'ask'
}

class PiRun implements HarnessRun {
  resumeKey: string | null
  private session: AgentSession | null = null
  private unsubscribe: (() => void) | null = null
  private policies: Map<string, ToolPolicy>
  private contextSent = false
  // Set when a message came back as a failed request, so the turn can end saying so.
  private turnFailed = false

  constructor(
    private options: HarnessRunOptions,
    policies: Map<string, ToolPolicy>
  ) {
    this.resumeKey = options.resumeKey
    this.policies = policies
  }

  /** Build the session, wire the approval hook, and start following its events. */
  async start(): Promise<void> {
    const { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } =
      await import('@earendil-works/pi-coding-agent')

    const modelRuntime = await ModelRuntime.create()
    const loader = new DefaultResourceLoader({
      cwd: this.options.workspaceRoot,
      agentDir: getAgentDir(),
      extensionFactories: [{ name: 'grove-approvals', factory: (pi) => this.bindApprovals(pi) }]
    })
    await loader.reload()

    const created = await createAgentSession({
      cwd: this.options.workspaceRoot,
      model: this.modelFor(modelRuntime),
      thinkingLevel: this.options.thinkingLevel,
      modelRuntime,
      resourceLoader: loader,
      customTools: this.options.tools.map((definition) => this.wrapTool(definition)),
      tools: this.options.activeTools ?? undefined,
      sessionManager: this.resumeKey
        ? SessionManager.open(this.resumeKey)
        : SessionManager.create(this.options.workspaceRoot)
    })

    this.session = created.session
    this.resumeKey = created.session.sessionFile ?? this.resumeKey
    this.unsubscribe = created.session.subscribe((event) => this.handle(event))
  }

  async prompt(text: string): Promise<void> {
    const session = this.session
    if (!session) throw new Error('the pi harness is not running')
    this.options.emit({ type: 'session.status_running' })
    await session.prompt(this.withGroveContext(text))
  }

  /**
   * grove's system prompt, carried on the first turn.
   *
   * pi builds its system prompt from its own resources and exposes no way to
   * append to it, so what grove has to say rides along with the opening message
   * instead. Sent once per run: everything after it is in the conversation.
   */
  private withGroveContext(text: string): string {
    const context = this.options.systemPrompt
    if (!context || this.contextSent) return text
    this.contextSent = true
    return `<grove-context>\n${context}\n</grove-context>\n\n${text}`
  }

  async steer(text: string, deliverAs: 'steer' | 'followUp'): Promise<void> {
    if (!this.session) return
    if (deliverAs === 'steer') await this.session.steer(text)
    else await this.session.followUp(text)
  }

  async interrupt(): Promise<void> {
    await this.session?.abort()
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
    this.unsubscribe?.()
    this.unsubscribe = null
    this.session?.dispose()
    this.session = null
    return Promise.resolve()
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
async function loadOffering(groveToolNames: string[]): Promise<HarnessOffering> {
  const { DefaultResourceLoader, ModelRuntime, SettingsManager, getAgentDir } =
    await import('@earendil-works/pi-coding-agent')

  const modelRuntime = await ModelRuntime.create()
  const available = await modelRuntime.getAvailable()
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir() })
  await loader.reload()
  const settings = SettingsManager.create(process.cwd(), getAgentDir())

  return {
    tools: toolInfos(groveToolNames),
    commands: loader.getPrompts().prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description ?? '',
      kind: 'prompt'
    })),
    skills: loader.getSkills().skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath
    })),
    providers: providersOf(available),
    default: defaultModelOf(available, settings)
  }
}

function toolInfos(groveToolNames: string[]): ToolInfo[] {
  const builtins = Object.entries(BUILTIN_POLICIES).map(([name, policy]) => ({
    name,
    description: '',
    policy,
    parallelSafe: policy === 'allow',
    inputSchema: {}
  }))
  const grove = groveToolNames.map((name) => ({
    name,
    description: '',
    policy: 'allow' as ToolPolicy,
    parallelSafe: false,
    inputSchema: {}
  }))
  return [...builtins, ...grove]
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

function providersOf(models: readonly unknown[]): ProviderModels[] {
  const byProvider = new Map<string, ProviderModels>()
  for (const entry of models as PiModel[]) {
    const group = byProvider.get(entry.provider) ?? { provider: entry.provider, models: [] }
    group.models.push({
      id: entry.id,
      provider: entry.provider,
      label: entry.name,
      contextWindow: entry.contextWindow
    })
    byProvider.set(entry.provider, group)
  }
  return [...byProvider.values()]
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
  // The policies a run enforces, filled in from the offering so a tool grove has
  // never heard of defaults to running without a prompt.
  const policies = new Map<string, ToolPolicy>(Object.entries(BUILTIN_POLICIES))

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
      groveTools: true
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

    offering: () => loadOffering([]),

    async start(options: HarnessRunOptions) {
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
