// The Claude Agent SDK, as a grove harness.
//
// The SDK runs one long-lived streaming query per session: messages are pushed
// into an async iterable and every push starts a turn, which is what lets grove
// keep a conversation open rather than re-establishing one per prompt. Tool
// approvals arrive through `canUseTool`, so grove's review flow can hold a write
// at the prompt and answer it once the user has decided.

import type { Context } from '@neoworks/extension-system'
import type {
  ModelInfo as SdkModelInfo,
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand
} from '@anthropic-ai/claude-agent-sdk'
import {
  SDK_PACKAGE,
  bundledExecutable,
  executableOnPath,
  resolveClaudeExecutable
} from '../claudeExecutable'
import { commandLine } from '../../../shared/agents'
import type {
  AgentMode,
  CommandInfo,
  ConfirmationResult,
  ContentBlock,
  CustomEndpoint,
  ImageBlock,
  ModelEntry,
  ModelRoute,
  ProviderCredential,
  ServerEventBody,
  ThinkingLevel,
  ToolDisplay,
  ToolInfo,
  ToolPolicy
} from '../../../shared/agents'
import type { EndpointsService } from '../../endpoints'
import { loadModelCatalog, type CatalogModel, type CatalogProvider } from '../../modelCatalog'
import { zodShapeFromJsonSchema, type JsonSchemaObject } from '../../plugins/zodSchema'
import type {
  GroveTool,
  HarnessDescriptor,
  HarnessOffering,
  HarnessRun,
  HarnessRunOptions,
  PromptAttachment,
  SubagentIdentity,
  ToolIntent
} from '../harness'

const HARNESS_ID = 'claude'

// Anthropic's own endpoint, which is what an account's own credentials reach.
// Everything the CLI itself lists is grouped under this one in the picker's
// provider → model cascade.
const PROVIDER = 'anthropic'

// How models.dev names the client of each wire protocol. Claude Code speaks the
// Anthropic Messages API and nothing else, so a provider is runnable here only
// if the catalog puts it on the Anthropic client — or on one of the two
// platforms the CLI has a flag for.
const ANTHROPIC_WIRE_SDK = '@ai-sdk/anthropic'
const BEDROCK_SDK = '@ai-sdk/amazon-bedrock'
const VERTEX_SDK = '@ai-sdk/google-vertex/anthropic'

// Bedrock and Vertex host far more than Claude; only the Claude lines can be
// driven from here, and the catalog names the line in `family`.
const CLAUDE_FAMILY = 'claude'

// The CLI's alias for "whatever is recommended right now". It is a way to reach
// a model rather than a name for one, so it never names an entry.
const RECOMMENDED_ALIAS = 'default'

// The MCP server grove's own tools are published under. The model sees them as
// `mcp__grove__<name>`, which is what the intent matcher below strips back off.
const GROVE_SERVER = 'grove'

// How long to wait for the offering query to report what the CLI can do. The
// CLI loads settings, plugins and MCP servers before it answers, so this is
// generous on purpose; it is off the path that decides availability.
const OFFERING_TIMEOUT_MS = 120_000

// Claude's file-writing tools, and the input field each one names the file with.
const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path'
}

/**
 * How Claude Code's own tools want their calls shown.
 *
 * The CLI describes its commands and models but not its tools, so the adapter
 * answers for them the same way it answers what a write would leave on disk. A
 * tool that is not named here renders the way any unknown tool does — this only
 * says which calls are worth reading as code rather than as arguments.
 */
const TOOL_DISPLAY: Record<string, ToolDisplay> = {
  // A command, laid out and highlighted as shell.
  Bash: { input: 'command' },
  BashOutput: { input: 'hidden' },
  // The file is already the header; its contents are the point.
  Read: { input: 'hidden', result: 'code', languageFrom: 'file_path' },
  // Each change to a file is worth its own row; the WRITE_TOOLS above.
  Write: { edits: true },
  Edit: { edits: true },
  MultiEdit: { edits: true },
  NotebookEdit: { edits: true }
}

/** Thinking levels mapped onto the SDK's token budget. `off` disables it. */
const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  low: 4_000,
  medium: 10_000,
  high: 32_000,
  xhigh: 64_000,
  max: 128_000
}

/**
 * A queue that presents itself as the async iterable the SDK consumes.
 *
 * The SDK pulls; grove pushes. Anything pushed before the SDK asks is buffered,
 * and a pull with nothing buffered parks until the next push or until the run
 * is closed.
 */
class MessageQueue {
  private buffered: SDKUserMessage[] = []
  private waiting: ((message: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false

  push(message: SDKUserMessage): void {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: message, done: false })
      return
    }
    this.buffered.push(message)
  }

  close(): void {
    this.closed = true
    this.waiting?.({ value: undefined as never, done: true })
    this.waiting = null
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.buffered.shift()
      if (next) {
        yield next
        continue
      }
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiting = resolve
      })
      if (result.done) return
      yield result.value
    }
  }
}

class ClaudeRun implements HarnessRun {
  resumeKey: string | null
  private query: Query | null = null
  private queue = new MessageQueue()
  private disposed = false
  // What grove has already told the session about: a turn grove did not start
  // still has to raise the status, or the pane offers no way to stop it.
  private running = false
  // What each tool call that is running an agent was asked to do, so the session
  // grove opens for it is named after the work rather than after a call id.
  private lanes = new Map<string, SubagentIdentity>()

  constructor(
    private options: HarnessRunOptions,
    private credentials: CredentialSource,
    private endpoints: EndpointsService
  ) {
    this.resumeKey = options.resumeKey
  }

  /** Open the query and start folding its messages onto the session log. */
  async start(): Promise<void> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    this.query = query({
      prompt: this.queue,
      options: await this.queryOptions()
    })
    void this.consume()
  }

  prompt(text: string, attachments: PromptAttachment[] = []): Promise<void> {
    if (!this.query) throw new Error('the Claude harness is not running')
    this.markRunning()
    this.queue.push(userMessage(text, attachments))
    return Promise.resolve()
  }

  steer(text: string): Promise<void> {
    this.queue.push(userMessage(text))
    return Promise.resolve()
  }

  /**
   * Claude Code parses slash commands out of the prompt itself, so a command is
   * sent the same way a message is — as the line the user would have typed.
   */
  command(name: string, args: string): Promise<void> {
    if (!this.query) throw new Error('the Claude harness is not running')
    this.markRunning()
    this.queue.push(userMessage(commandLine(name, args)))
    return Promise.resolve()
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt()
  }

  async setModel(_provider: string | null, model: string): Promise<void> {
    await this.query?.setModel(model)
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const budget = THINKING_BUDGETS[level]
    await this.query?.setMaxThinkingTokens(budget)
  }

  async setPermissionMode(mode: AgentMode): Promise<void> {
    await this.query?.setPermissionMode(sdkPermissionMode(mode))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.queue.close()
    await this.query?.return(undefined).catch(() => {})
    this.query = null
  }

  // ── Wiring ──────────────────────────────────────────────────────

  private async queryOptions(): Promise<Options> {
    const budget = THINKING_BUDGETS[this.options.thinkingLevel]
    return {
      cwd: this.options.workspaceRoot,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      env: await sessionEnvironment(this.options.provider, this.credentials, this.endpoints),
      model: this.options.model ?? undefined,
      resume: this.options.resumeKey ?? undefined,
      includePartialMessages: true,
      maxThinkingTokens: budget === 0 ? undefined : budget,
      // `tools`, not `allowedTools`: grove's activeTools is a restriction, and
      // `allowedTools` is the SDK's auto-approve list — passing it there let
      // every listed tool run unasked while restricting nothing.
      tools: this.options.activeTools ?? undefined,
      // Claude Code's own subagents run hidden inside the turn; grove's
      // `spawn_agent` is the one way a session starts another agent, so it shows
      // up in the worktree beside the rest. `Task` is the tool's older name.
      disallowedTools: ['Agent', 'Task'],
      permissionMode: sdkPermissionMode(this.options.permissionMode),
      // The CLI's own prompt still leads; grove's part is appended to it, so a
      // session keeps every Claude Code behaviour and gains the worktree it is
      // working in and the agents it shares that worktree with.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: this.options.systemPrompt || undefined
      },
      mcpServers: await this.groveServer(),
      canUseTool: async (name, input, { toolUseID }) => {
        // grove's own tools carry the policy grove gave them, so the ones that
        // only drive its UI run without stopping the turn on an approval.
        if (this.policyFor(name) === 'allow') return { behavior: 'allow', updatedInput: input }
        // The same name the tool call was announced under, so the approval lands
        // on that call rather than raising a second one beside it.
        const decision = await this.options.confirm({
          toolUseId: toolUseID,
          name: bareName(name),
          input
        })
        if (!allows(decision.result)) {
          return { behavior: 'deny', message: decision.reason ?? 'denied by the user' }
        }
        // The user may have rewritten the arguments, or answered a call that
        // asked them something; either way the call runs with what they gave.
        return { behavior: 'allow', updatedInput: asInput(decision.input) ?? input }
      }
    }
  }

  /**
   * The policy grove attached to a tool. Only its own tools have one; everything
   * the CLI brings is asked about, which is what the review flow hangs on.
   */
  private policyFor(name: string): ToolPolicy {
    const definition = this.options.tools.find((tool) => tool.name === bareName(name))
    if (!definition) return 'ask'
    return definition.policy
  }

  /** grove's own tools, published as an in-process MCP server. */
  private async groveServer(): Promise<Options['mcpServers']> {
    if (this.options.tools.length === 0) return undefined
    const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
    return {
      [GROVE_SERVER]: createSdkMcpServer({
        name: GROVE_SERVER,
        tools: this.options.tools.map((definition) => this.wrapTool(tool, definition))
      })
    }
  }

  private wrapTool(
    factory: typeof import('@anthropic-ai/claude-agent-sdk').tool,
    definition: GroveTool
  ): ReturnType<typeof import('@anthropic-ai/claude-agent-sdk').tool> {
    return factory(
      definition.name,
      definition.description,
      zodShapeFromJsonSchema(definition.inputSchema as JsonSchemaObject),
      async (input: Record<string, unknown>) => {
        const result = await definition.execute(input, {
          sessionId: this.options.sessionId,
          workspaceRoot: this.options.workspaceRoot,
          surface: (surfaceId, slot, view) =>
            this.options.emit({ type: 'ui.surface', surfaceId, slot, view } as ServerEventBody),
          openFiles: (files) => this.options.emit({ type: 'ui.open_files', files })
        })
        return { content: [{ type: 'text' as const, text: result.content }] }
      }
    )
  }

  private async consume(): Promise<void> {
    if (!this.query) return
    try {
      for await (const message of this.query) this.handle(message)
    } catch (cause) {
      if (this.disposed) return
      this.running = false
      this.options.emit({ type: 'session.error', message: (cause as Error).message })
      this.options.emit({ type: 'session.status_idle', stopReason: 'error' })
    }
  }

  private handle(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.resumeKey = message.session_id
      return
    }
    if (this.handleSessionChange(message)) return
    if (signalsWork(message)) this.markRunning()
    if (message.type === 'stream_event') {
      this.report(message.parent_tool_use_id, streamEvents(message.event))
      return
    }
    if (message.type === 'assistant') {
      this.rememberLanes(message.message.content)
      this.nameLane(message.parent_tool_use_id, message.subagent_type, message.task_description)
      this.report(message.parent_tool_use_id, assistantEvents(message.message.content))
      return
    }
    if (message.type === 'user') {
      const events = toolResultEvents(message.message.content, (image) =>
        this.options.storeImage(image)
      )
      this.report(message.parent_tool_use_id, events)
      return
    }
    if (message.type === 'result') this.handleResult(message)
  }

  /**
   * Put events on the conversation they belong to.
   *
   * A `parentToolUseId` means an agent the runtime is running inside that call,
   * which grove gives a session of its own; everything else is the conversation
   * the user is reading.
   */
  private report(parentToolUseId: string | null, events: ServerEventBody[]): void {
    if (!parentToolUseId) {
      for (const event of events) this.options.emit(event)
      return
    }
    const agent = this.laneOf(parentToolUseId)
    for (const event of events) this.options.emitFrom(agent, event)
  }

  /**
   * Keep what each tool call was asked to do.
   *
   * A subagent's own messages say almost nothing about it — the task it was
   * given is in the call that started it, and that call goes past before any of
   * its work does.
   */
  private rememberLanes(content: unknown): void {
    for (const block of blocksOf(content)) {
      if (block.type !== 'tool_use') continue
      const input = asInput(block.input) ?? {}
      this.lanes.set(String(block.id), {
        toolUseId: String(block.id),
        title: subagentTitle(input, String(block.name)),
        description: subagentDescription(input)
      })
    }
  }

  /** The subagent type, once a message from it says which one it is. */
  private nameLane(
    parentToolUseId: string | null,
    subagentType: string | undefined,
    taskDescription: string | undefined
  ): void {
    if (!parentToolUseId) return
    const known = this.laneOf(parentToolUseId)
    this.lanes.set(parentToolUseId, {
      ...known,
      title: subagentType || known.title,
      description: known.description || taskDescription
    })
  }

  /** What grove should call the agent running in one tool call. */
  private laneOf(toolUseId: string): SubagentIdentity {
    return this.lanes.get(toolUseId) ?? { toolUseId, title: 'Agent' }
  }

  /**
   * Say the session is working, once per turn.
   *
   * Only some turns are ones grove asked for: a background agent finishing hands
   * the conversation back to the model on its own, and the stream simply starts
   * producing again. Raising the status from the stream rather than from the
   * prompt is what keeps the Stop button on screen for those.
   */
  private markRunning(): void {
    if (this.running) return
    this.running = true
    this.options.emit({ type: 'session.status_running' })
  }

  /**
   * What the CLI's own commands did to the session.
   *
   * Commands like `/clear`, `/compact` and `/usage` run inside Claude Code
   * rather than in grove, and report back out of band: the conversation is gone,
   * the context was summarised, a command has something to print. Returns true
   * when the message was one of those and needs no further handling.
   */
  private handleSessionChange(message: SDKMessage): boolean {
    if (message.type === 'conversation_reset') {
      this.resumeKey = message.new_conversation_id
      this.options.emit({ type: 'session.cleared' })
      return true
    }
    if (message.type !== 'system') return false
    if (message.subtype === 'local_command_output') {
      this.options.emit({ type: 'session.command_output', text: message.content })
      return true
    }
    if (message.subtype === 'compact_boundary') {
      this.options.emit({ type: 'session.notice', message: compactionNotice(message) })
      return true
    }
    return false
  }

  private handleResult(message: Extract<SDKMessage, { type: 'result' }>): void {
    if ('usage' in message && message.usage) {
      this.options.stats({
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0
        },
        cost: message.total_cost_usd ?? 0,
        contextWindow: 0
      })
    }
    this.running = false
    const failed = message.subtype !== 'success'
    if (failed) {
      this.options.emit({ type: 'session.error', message: `run ended: ${message.subtype}` })
    }
    this.options.emit({
      type: 'session.status_idle',
      stopReason: failed ? 'error' : 'end_turn'
    })
  }
}

/** Reads a provider's credential, wherever the user put it. */
export interface CredentialSource {
  /** The first of these environment variables that has a value, if any. */
  lookup(variables: string[]): string | null
}

/** Probe the SDK once for what it can offer, and remember the answer. */
class Offering {
  private cached: HarnessOffering | null = null
  private inflight: Promise<HarnessOffering> | null = null

  constructor(
    private credentials: CredentialSource,
    private endpoints: EndpointsService
  ) {}

  /**
   * The user's own endpoints, with whatever each one serves.
   *
   * Asked for here rather than built from a stored list, because a gateway's
   * catalog is its own to change: OpenRouter gains models weekly, and a local
   * proxy serves whatever has been pulled onto the machine that day.
   */
  private async customRoutes(): Promise<EndpointModels[]> {
    await this.endpoints.load()
    return Promise.all(
      this.endpoints.list().map(async (endpoint) => ({
        endpoint,
        models: await this.endpoints.modelsOf(endpoint, this.keyFor(endpoint))
      }))
    )
  }

  private keyFor(endpoint: CustomEndpoint): string | null {
    if (!endpoint.keyVariable) return null
    return this.credentials.lookup([endpoint.keyVariable])
  }

  async load(): Promise<HarnessOffering> {
    if (this.cached) return this.cached
    if (!this.inflight) {
      this.inflight = this.probe().finally(() => {
        this.inflight = null
      })
    }
    return this.inflight
  }

  /**
   * Ask a throwaway streaming query what it can do.
   *
   * Everything comes off the control channel, which the CLI answers as soon as
   * it has connected. The `system/init` message would also name the built-in
   * tools, but it is only sent once a turn begins — behind settings, plugin and
   * MCP-server startup — so waiting for it made the catalog take minutes or time
   * out altogether. Nothing here starts a turn, so nothing is charged for it.
   *
   * Skills arrive as commands (the CLI lists them alongside the built-ins), so
   * they are not enumerated separately.
   */
  private async probe(): Promise<HarnessOffering> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const queue = new MessageQueue()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), OFFERING_TIMEOUT_MS)
    const session = query({
      prompt: queue,
      options: {
        abortController: abort,
        pathToClaudeCodeExecutable: resolveClaudeExecutable()
      }
    })

    try {
      const initialization = await session.initializationResult()
      // The catalog only widens the list, so a failed or empty one costs the
      // extra providers and nothing else.
      const catalog = await loadModelCatalog()
      const custom = await this.customRoutes()
      this.cached = {
        tools: builtinTools(),
        commands: commandsOf(initialization.commands),
        skills: [],
        models: modelsOf(initialization.models, catalog, this.credentials, custom),
        default: defaultModelOf(initialization.models)
      }
      return this.cached
    } finally {
      clearTimeout(timer)
      queue.close()
      await session.return(undefined).catch(() => {})
    }
  }
}

/**
 * The built-in tools grove has something to say about.
 *
 * Only their display matters here: the CLI owns what they do, their schemas and
 * whether they may run, so everything else is left at what an unknown tool gets.
 */
function builtinTools(): ToolInfo[] {
  return Object.entries(TOOL_DISPLAY).map(([name, display]) => ({
    name,
    description: '',
    policy: 'ask' as ToolPolicy,
    parallelSafe: false,
    display,
    inputSchema: {}
  }))
}

function commandsOf(commands: SlashCommand[]): CommandInfo[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    kind: 'command'
  }))
}

/**
 * Every model a session can run, with each way of reaching it.
 *
 * Two sources, because neither is complete on its own. The CLI reports the
 * aliases the signed-in account is entitled to — authoritative about the
 * account, silent about every model it is not entitled to and every endpoint it
 * does not sign in to. The catalog reports the models that exist, and who
 * serves them. The same model arrives from both under three or four different
 * ids, so routes are grouped by what the id normalises to.
 */
export function modelsOf(
  models: SdkModelInfo[],
  catalog: CatalogProvider[],
  credentials: CredentialSource,
  custom: EndpointModels[] = []
): ModelEntry[] {
  const entries = new Map<string, ModelEntry>()
  // How good the name each entry currently carries is, so a better one can
  // replace it without the order routes arrive in deciding anything.
  const ranks = new Map<string, number>()
  for (const keyed of collectRoutes(models, catalog, credentials, custom)) {
    addRoute(entries, ranks, keyed)
  }
  return [...entries.values()].sort(byNativeThenName)
}

interface KeyedRoute {
  key: string
  /** What to call the model this route reaches, if the route knows. */
  label: string | null
  /**
   * How much the label is worth. Bedrock lists the same model as "AU Anthropic
   * Claude Opus 4.6", one row per region; Anthropic calls it "Claude Opus 4.6".
   * The higher rank wins, so a model reads as its maker names it.
   */
  labelRank: number
  route: ModelRoute
}

// Label ranks, lowest first: a platform's own listing name ("AU Anthropic
// Claude Opus 4.6"), then the recommendation alias, which names no model at
// all, then the alias that does name one ("Opus (1M context)"), then
// Anthropic's own name for it.
const RANK_PLATFORM = 0
const RANK_RECOMMENDED_ALIAS = 1
const RANK_NATIVE = 2
const RANK_ANTHROPIC = 3

/** One of the user's endpoints, with the models it turned out to serve. */
export interface EndpointModels {
  endpoint: CustomEndpoint
  models: string[]
}

function collectRoutes(
  models: SdkModelInfo[],
  catalog: CatalogProvider[],
  credentials: CredentialSource,
  custom: EndpointModels[]
): KeyedRoute[] {
  // The CLI's own rows first: a native route displaces a derived one, and the
  // model the account is entitled to is the one worth defaulting to.
  const routes = models.map(routeFromCli)
  for (const provider of catalog) {
    const credential = credentialState(provider, credentials)
    for (const model of runnableModels(provider)) {
      routes.push(routeFromCatalog(model, provider, credential))
    }
  }
  for (const entry of custom) {
    for (const id of entry.models) {
      routes.push(routeFromEndpoint(id, entry.endpoint, credentials))
    }
  }
  return routes
}

/**
 * A model on an endpoint the user brought.
 *
 * Its ids are the gateway's own — `moonshotai/kimi-k2` on OpenRouter, whatever
 * a local proxy calls what it has loaded — so they are filed under the last
 * segment: the same model reached through three gateways is one row, and the
 * route says which gateway.
 */
function routeFromEndpoint(
  id: string,
  endpoint: CustomEndpoint,
  credentials: CredentialSource
): KeyedRoute {
  return {
    key: normalizeModelId(id.split('/').pop() ?? id),
    label: null,
    labelRank: RANK_PLATFORM,
    route: {
      provider: endpoint.id,
      providerLabel: endpoint.label,
      id,
      endpoint: endpoint.baseUrl,
      credential: endpointCredential(endpoint, credentials)
    }
  }
}

/** An endpoint with no key named needs none — a local proxy usually does not. */
function endpointCredential(
  endpoint: CustomEndpoint,
  credentials: CredentialSource
): ProviderCredential | undefined {
  if (!endpoint.keyVariable) return undefined
  return {
    kind: 'key',
    env: [endpoint.keyVariable],
    present: credentials.lookup([endpoint.keyVariable]) !== null
  }
}

/**
 * A row the CLI listed.
 *
 * Every one of them is an alias (`default`, `opus[1m]`) rather than a wire model
 * id, so the route is filed under `resolvedModel`: it is the only way to know
 * which model `default` is a way of reaching.
 */
function routeFromCli(model: SdkModelInfo): KeyedRoute {
  const resolved = model.resolvedModel ?? model.value
  return {
    key: normalizeModelId(resolved),
    // An alias mostly names the model well enough to stand in until the catalog
    // offers Anthropic's own name — except `default`, which names only the fact
    // that the CLI recommends it, and would still read that way next release.
    label: model.displayName,
    labelRank: model.value === RECOMMENDED_ALIAS ? RANK_RECOMMENDED_ALIAS : RANK_NATIVE,
    route: {
      provider: PROVIDER,
      providerLabel: 'Anthropic',
      id: model.value,
      label: model.displayName,
      native: true
    }
  }
}

function routeFromCatalog(
  model: CatalogModel,
  provider: CatalogProvider,
  credential: ProviderCredential | undefined
): KeyedRoute {
  return {
    key: normalizeModelId(model.id),
    label: model.name,
    labelRank: provider.id === PROVIDER ? RANK_ANTHROPIC : RANK_PLATFORM,
    route: {
      provider: provider.id,
      providerLabel: provider.name,
      id: model.id,
      endpoint: provider.api ?? undefined,
      credential,
      contextWindow: model.contextWindow ?? undefined,
      pricing: model.pricing ?? undefined
    }
  }
}

/**
 * File one route under its model.
 *
 * Every route the CLI itself listed is kept, even when two of them reach the
 * same model: `default` and `opus[1m]` both resolve to Claude Opus 5 with a 1M
 * window, and they are two things a person can pick — one follows whatever the
 * CLI recommends, the other names the model. Dropping either loses a choice the
 * account has.
 *
 * What is dropped is the catalog's own copy of a route the CLI already covers:
 * the same endpoint under the wire id, which would list Anthropic twice.
 */
function addRoute(
  entries: Map<string, ModelEntry>,
  ranks: Map<string, number>,
  keyed: KeyedRoute
): void {
  const { key, label, labelRank, route } = keyed
  const entry = entries.get(key)
  if (!entry) {
    entries.set(key, { key, label: label ?? route.label ?? key, routes: [route] })
    ranks.set(key, label ? labelRank : -1)
    return
  }
  if (label && isBetterLabel(entry.label, label, labelRank, ranks.get(key) ?? -1)) {
    entry.label = label
    ranks.set(key, labelRank)
  }

  const sameRoute = entry.routes.findIndex(
    (candidate) => candidate.provider === route.provider && candidate.id === route.id
  )
  if (sameRoute !== -1) {
    entry.routes[sameRoute] = mergeRoutes(entry.routes[sameRoute], route)
    return
  }

  // A catalog row for a provider the CLI already reaches this model through is
  // that same route under another name; the blessed one keeps the slot, and
  // learns the price and context window the catalog knows.
  if (!route.native) {
    const native = entry.routes.findIndex(
      (candidate) => candidate.native && candidate.provider === route.provider
    )
    if (native !== -1) {
      entry.routes[native] = mergeRoutes(entry.routes[native], route)
      return
    }
  }

  entry.routes.push(route)
}

/**
 * Whether a name should replace the one an entry carries.
 *
 * Rank decides it, and where two sources rank the same the shorter name wins:
 * the catalog lists a moving id and the snapshot it points at as "Claude Haiku
 * 4.5 (latest)" and "Claude Haiku 4.5", and they are the same model.
 */
function isBetterLabel(
  current: string,
  candidate: string,
  candidateRank: number,
  currentRank: number
): boolean {
  if (candidateRank > currentRank) return true
  if (candidateRank < currentRank) return false
  return candidate.length < current.length
}

/** The blessed route, told whatever the other one knew about the model. */
function mergeRoutes(left: ModelRoute, right: ModelRoute): ModelRoute {
  const [kept, other] = left.native ? [left, right] : [right, left]
  return {
    ...kept,
    contextWindow: kept.contextWindow ?? other.contextWindow,
    pricing: kept.pricing ?? other.pricing,
    credential: kept.credential ?? other.credential
  }
}

/**
 * The id a provider uses, as the model behind it.
 *
 * Platforms spell the same model their own way — Bedrock prefixes a region and
 * `anthropic.` and suffixes a version, Vertex suffixes `@default` — and none of
 * that is part of the model. Variants that genuinely differ, `[1m]` above all,
 * survive: they are a different model to run.
 */
export function normalizeModelId(id: string): string {
  return (
    id
      .replace(/^[a-z0-9-]+\.anthropic\./, '')
      .replace(/^anthropic\./, '')
      .replace(/@.*$/, '')
      .replace(/-v\d+(?::\d+)?$/, '')
      // A dated snapshot is the same model as the moving id that points at it:
      // `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are one row, not two.
      .replace(/-\d{8}$/, '')
      .toLowerCase()
  )
}

/** Entries the account can run come first; the rest read alphabetically. */
function byNativeThenName(left: ModelEntry, right: ModelEntry): number {
  const leftNative = left.routes.some((route) => route.native)
  const rightNative = right.routes.some((route) => route.native)
  if (leftNative !== rightNative) return leftNative ? -1 : 1
  return left.label.localeCompare(right.label)
}

/** The models of one catalog provider that Claude Code can actually drive. */
function runnableModels(provider: CatalogProvider): CatalogModel[] {
  if (provider.sdk === ANTHROPIC_WIRE_SDK) return provider.models
  if (provider.sdk !== BEDROCK_SDK && provider.sdk !== VERTEX_SDK) return []
  return provider.models.filter((model) => {
    const family = model.family ?? model.id
    return family.toLowerCase().includes(CLAUDE_FAMILY)
  })
}

/**
 * What a route asks for before it can be taken.
 *
 * Anthropic's own endpoint asks for nothing: the CLI signs itself in, and the
 * account behind that sign-in is exactly what makes a route native. Bedrock and
 * Vertex sign in through their own cloud tooling — a profile, an instance role,
 * application-default credentials — which grove cannot see, so they are
 * reported as a platform sign-in instead of a key to be typed. Everything else
 * is one key, which grove can hold.
 */
function credentialState(
  provider: CatalogProvider,
  credentials: CredentialSource
): ProviderCredential | undefined {
  if (provider.id === PROVIDER) return undefined
  if (provider.env.length === 0) return undefined
  if (provider.sdk === BEDROCK_SDK || provider.sdk === VERTEX_SDK) {
    return { kind: 'platform', env: provider.env, present: false }
  }
  return {
    kind: 'key',
    env: provider.env,
    present: credentials.lookup(provider.env) !== null
  }
}

/**
 * The environment a session runs the CLI under.
 *
 * Anthropic's own endpoint needs nothing: the CLI already knows how the account
 * signs in. Every other provider is reached the way Claude Code documents it —
 * `ANTHROPIC_BASE_URL` at the endpoint, the provider's own key as
 * `ANTHROPIC_AUTH_TOKEN`, or the platform flag for Bedrock and Vertex.
 *
 * The SDK replaces the child's environment with whatever is returned here, so
 * this starts from grove's own.
 */
async function sessionEnvironment(
  provider: string | null,
  credentials: CredentialSource,
  endpoints: EndpointsService
): Promise<Record<string, string | undefined> | undefined> {
  if (!provider || provider === PROVIDER) return undefined

  await endpoints.load()
  const own = endpoints.find(provider)
  if (own) return { ...process.env, ...endpointVariables(own, credentials) }

  const entry = (await loadModelCatalog()).find((candidate) => candidate.id === provider)
  if (!entry) return undefined
  return { ...process.env, ...providerVariables(entry, credentials) }
}

/** What running against one of the user's own endpoints takes. */
export function endpointVariables(
  endpoint: CustomEndpoint,
  credentials: CredentialSource
): Record<string, string | undefined> {
  const variables: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    // Not Anthropic on the other end, so grove's own key must not travel there.
    ANTHROPIC_API_KEY: undefined
  }
  if (!endpoint.keyVariable) return variables
  const key = credentials.lookup([endpoint.keyVariable])
  if (key) variables.ANTHROPIC_AUTH_TOKEN = key
  return variables
}

export function providerVariables(
  provider: CatalogProvider,
  credentials: CredentialSource
): Record<string, string | undefined> {
  if (provider.sdk === BEDROCK_SDK) return { CLAUDE_CODE_USE_BEDROCK: '1' }
  if (provider.sdk === VERTEX_SDK) return { CLAUDE_CODE_USE_VERTEX: '1' }

  const variables: Record<string, string | undefined> = {}
  if (provider.api) variables.ANTHROPIC_BASE_URL = provider.api
  const token = credentials.lookup(provider.env)
  if (token) variables.ANTHROPIC_AUTH_TOKEN = token
  // The session is no longer talking to Anthropic, so the Anthropic credentials
  // in grove's own environment must not travel to whoever is on the other end.
  variables.ANTHROPIC_API_KEY = undefined
  return variables
}

/** The CLI lists its recommended model first, which is the one to start on. */
function defaultModelOf(models: SdkModelInfo[]): { provider: string; model: string } | null {
  const first = models[0]
  if (!first) return null
  return { provider: PROVIDER, model: first.value }
}

/**
 * What a compaction did, in tokens.
 *
 * The boundary reports token counts rather than a message count or a summary,
 * so it is said as a notice instead of `session.compacted` — which promises
 * both.
 */
function compactionNotice(message: Extract<SDKMessage, { subtype: 'compact_boundary' }>): string {
  const { trigger, pre_tokens: before, post_tokens: after } = message.compact_metadata
  if (typeof after !== 'number') {
    return `Context compacted (${trigger}) from ${before.toLocaleString()} tokens.`
  }
  return `Context compacted (${trigger}): ${before.toLocaleString()} → ${after.toLocaleString()} tokens.`
}

/**
 * Is this message the session doing work?
 *
 * Not every turn starts with a prompt grove sent: a background agent finishing
 * hands the conversation back to the model on its own, and the only sign of it
 * is the stream producing again. A session that does not notice reads as idle
 * while it writes, which leaves nothing on screen to stop it with.
 */
export function signalsWork(message: SDKMessage): boolean {
  return message.type === 'stream_event' || message.type === 'assistant' || message.type === 'user'
}

/** The transcript events a partial message carries. */
export function streamEvents(rawEvent: unknown): ServerEventBody[] {
  const event = rawEvent as { type: string; delta?: Record<string, unknown> }
  if (event.type === 'message_start') return [{ type: 'agent.message_start' }]
  if (event.type !== 'content_block_delta') return []

  const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined
  if (delta?.type === 'text_delta' && delta.text) {
    return [{ type: 'agent.message_delta', text: delta.text }]
  }
  if (delta?.type === 'thinking_delta' && delta.thinking) {
    return [{ type: 'agent.thinking_delta', text: delta.thinking }]
  }
  return []
}

/** The transcript events an assistant message carries: its tool calls, and the block it closes. */
export function assistantEvents(content: unknown): ServerEventBody[] {
  const blocks = blocksOf(content)
  const calls: ServerEventBody[] = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      type: 'agent.tool_use',
      toolUseId: String(block.id),
      // grove's own tools travel as `mcp__grove__<name>`; the rest of grove
      // knows them by the name it gave them, and so does the transcript.
      name: bareName(String(block.name)),
      input: block.input,
      permission: 'allow'
    }))

  return [
    ...calls,
    { type: 'agent.message_end', content: blocks as ContentBlock[], stopReason: 'end_turn' }
  ]
}

/**
 * The transcript events a user message carries: what the tools it ran answered.
 * Images among a result's blocks go to `storeImage` and travel as blob references.
 */
export function toolResultEvents(
  content: unknown,
  storeImage?: (image: PromptAttachment) => ImageBlock
): ServerEventBody[] {
  return blocksOf(content)
    .filter((block) => block.type === 'tool_result')
    .map((block) => {
      const event: Extract<ServerEventBody, { type: 'agent.tool_result' }> = {
        type: 'agent.tool_result',
        toolUseId: String(block.tool_use_id),
        name: '',
        content: textOf(block.content),
        isError: block.is_error === true
      }
      const images = imagesOf(block.content)
      if (images.length > 0 && storeImage) {
        event.images = images.map(storeImage)
      }
      return event
    })
}

/** The base64 images among a tool result's blocks. */
function imagesOf(content: unknown): PromptAttachment[] {
  const images: PromptAttachment[] = []
  for (const block of blocksOf(content)) {
    if (block.type !== 'image') continue
    const source = block.source as Record<string, unknown> | undefined
    if (source?.type !== 'base64') continue
    images.push({ mediaType: String(source.media_type), data: String(source.data) })
  }
  return images
}

// What Claude's Task tool names the agent it starts, and the work it gives it.
// A harness that spawns agents some other way names them some other way; this is
// only what this one's calls look like.
const SUBAGENT_TYPE_FIELDS = ['subagent_type', 'agent_type', 'agent']
const SUBAGENT_TASK_FIELDS = ['description', 'prompt', 'task']

/** What to call the agent a tool call starts: the agent type it names, else the tool. */
function subagentTitle(input: Record<string, unknown>, toolName: string): string {
  const named = firstString(input, SUBAGENT_TYPE_FIELDS)
  if (named) return named
  return bareName(toolName)
}

/** The task a tool call hands its agent, shown as the first thing in its transcript. */
function subagentDescription(input: Record<string, unknown>): string | undefined {
  return firstString(input, SUBAGENT_TASK_FIELDS)
}

function firstString(input: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = input[field]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/**
 * One turn's input, as the SDK takes it.
 *
 * Images lead and the text follows: the model reads a prompt that refers to
 * "this screenshot" better when the image is already in front of it, which is
 * the ordering Anthropic's own guidance gives.
 */
function userMessage(text: string, attachments: PromptAttachment[] = []): SDKUserMessage {
  const images = attachments.map((attachment) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: attachment.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
      data: attachment.data
    }
  }))
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [...images, { type: 'text', text }] }
  }
}

/**
 * grove's mode as the SDK's own.
 *
 * Only plan mode is handed over. Plan mode is the one grove cannot implement
 * itself — it withholds the mutating tools and adds the plan-mode protocol to
 * the system prompt, both of which live inside the harness. The permissive
 * modes stay grove's: answering them in `canUseTool` is what keeps every call
 * on the event log, and what lets the review flow see the ones it gates.
 */
function sdkPermissionMode(mode: AgentMode): PermissionMode {
  if (mode === 'plan') return 'plan'
  return 'default'
}

function allows(result: ConfirmationResult): boolean {
  return result !== 'deny'
}

/** A replacement input the SDK will take, or null when there is none to take. */
function asInput(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** A message's content blocks, whatever shape the SDK handed over. */
function blocksOf(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return []
  return content as Record<string, unknown>[]
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return blocksOf(content).map(blockText).join('')
}

function blockText(block: Record<string, unknown>): string {
  if (block.type !== 'text') return ''
  return String(block.text)
}

/** The review header the agent wrote, if it wrote one. */
function summaryOf(input: Record<string, unknown>): string {
  if (typeof input.summary !== 'string') return ''
  return input.summary
}

/** Strip the MCP prefix so grove's own tools are recognisable by their bare name. */
function bareName(name: string): string {
  const prefix = `mcp__${GROVE_SERVER}__`
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/**
 * What one of Claude's write tools would leave on disk. `Write` replaces the
 * file; the edit tools apply exact-match replacements in order, each against the
 * text the previous one produced.
 */
export function proposedContent(
  name: string,
  input: Record<string, unknown>,
  original: string
): string | null {
  if (name === 'Write') return typeof input.content === 'string' ? input.content : null
  if (name === 'NotebookEdit') return null

  const edits = editsOf(name, input)
  if (edits.length === 0) return null

  let text = original
  for (const edit of edits) {
    if (edit.oldText.length === 0) continue
    text = edit.replaceAll
      ? text.split(edit.oldText).join(edit.newText)
      : text.replace(edit.oldText, edit.newText)
  }
  return text
}

interface Replacement {
  oldText: string
  newText: string
  replaceAll: boolean
}

function editsOf(name: string, input: Record<string, unknown>): Replacement[] {
  if (name === 'Edit') {
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return []
    return [
      {
        oldText: input.old_string,
        newText: input.new_string,
        replaceAll: input.replace_all === true
      }
    ]
  }
  if (name !== 'MultiEdit' || !Array.isArray(input.edits)) return []
  return (input.edits as Record<string, unknown>[])
    .filter((edit) => typeof edit.old_string === 'string' && typeof edit.new_string === 'string')
    .map((edit) => ({
      oldText: String(edit.old_string),
      newText: String(edit.new_string),
      replaceAll: edit.replace_all === true
    }))
}

function createClaudeHarness(
  credentials: CredentialSource,
  endpoints: EndpointsService
): HarnessDescriptor {
  const offering = new Offering(credentials, endpoints)

  return {
    id: HARNESS_ID,
    label: 'Claude',
    description: "Anthropic's Claude Agent SDK, running the Claude Code loop in process.",
    icon: 'grove:claude',
    capabilities: {
      approvals: true,
      interrupt: true,
      liveModelSwitch: true,
      thinking: true,
      steering: true,
      groveTools: true,
      attachments: true
    },

    // Availability is only "is there a CLI to spawn". Loading the offering here
    // instead would tie the harness list to how long the CLI takes to start,
    // which is long enough to leave Claude greyed out in the picker.
    probe() {
      const executable = bundledExecutable() ?? executableOnPath('claude')
      if (executable !== null) return Promise.resolve({ available: true, detail: null })
      return Promise.resolve({
        available: false,
        detail: `no Claude Code CLI found — install ${SDK_PACKAGE} with its optional packages, or put \`claude\` on PATH`
      })
    },

    offering: () => offering.load(),

    async start(options) {
      const run = new ClaudeRun(options, credentials, endpoints)
      await run.start()
      return run
    },

    intentOf(name, input) {
      const bare = bareName(name)
      if (bare === 'request_review') return { kind: 'review', summary: summaryOf(input) }
      const pathField = WRITE_TOOLS[name]
      if (!pathField) return null
      const path = input[pathField]
      if (typeof path !== 'string') return null
      return {
        kind: 'write',
        path,
        apply: (original) => proposedContent(name, input, original)
      } satisfies ToolIntent
    }
  }
}

export const claudeHarness = {
  name: 'main/harness/claude',
  inject: ['harnesses', 'secrets', 'endpoints'],

  apply(ctx: Context): void {
    // The secrets store is the credential source: it reads grove's environment
    // first and its own encrypted file second, so an exported key needs no UI.
    ctx.effect(
      () => ctx.harnesses.register(createClaudeHarness(ctx.secrets, ctx.endpoints)),
      'harness:claude'
    )
  }
}
