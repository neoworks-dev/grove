// The Claude Agent SDK, as a grove harness.
//
// The SDK runs one long-lived streaming query per session: messages are pushed
// into an async iterable and every push starts a turn, which is what lets grove
// keep a conversation open rather than re-establishing one per prompt. Tool
// approvals arrive through `canUseTool`, so grove's review flow can hold a write
// at the prompt and answer it once the user has decided.

import { accessSync, constants, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import type { Context } from '@neoworks/extension-system'
import type {
  ModelInfo as SdkModelInfo,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand
} from '@anthropic-ai/claude-agent-sdk'
import { commandLine } from '../../../shared/agents'
import type {
  CommandInfo,
  ConfirmationResult,
  ContentBlock,
  ModelEntry,
  ModelRoute,
  ProviderCredential,
  ServerEventBody,
  ThinkingLevel,
  ToolDisplay,
  ToolInfo,
  ToolPolicy
} from '../../../shared/agents'
import { loadModelCatalog, type CatalogModel, type CatalogProvider } from '../../modelCatalog'
import { zodShapeFromJsonSchema, type JsonSchemaObject } from '../../plugins/zodSchema'
import type {
  GroveTool,
  HarnessDescriptor,
  HarnessOffering,
  HarnessRun,
  HarnessRunOptions,
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
  Read: { input: 'hidden', result: 'code', languageFrom: 'file_path' }
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

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/**
 * Which Claude Code executable the SDK should spawn, or `undefined` to let it
 * pick its own.
 *
 * The SDK ships the CLI as per-platform optional dependencies and refuses to
 * start when none of them is installed — which is what any install that skipped
 * optional packages leaves behind, and it surfaces as the whole harness being
 * unavailable. Grove looks those packages up itself and, when none is there,
 * falls back to a `claude` on PATH so a system install serves just as well.
 */
function resolveClaudeExecutable(): string | undefined {
  if (bundledExecutable() !== null) return undefined
  return executableOnPath('claude') ?? undefined
}

/**
 * The CLI shipped inside one of the SDK's per-platform packages.
 *
 * The names are read off the SDK's own `optionalDependencies` rather than
 * rebuilt from `process.platform`, so grove does not have to track how the SDK
 * names its targets: only the package for this platform is ever installed, so
 * the first one that resolves is the right one.
 */
function bundledExecutable(): string | null {
  const require = createRequire(__filename)
  for (const name of platformPackages(require)) {
    for (const entry of ['claude', 'claude.exe']) {
      try {
        return require.resolve(`${name}/${entry}`)
      } catch {
        continue
      }
    }
  }
  return null
}

interface SdkManifest {
  optionalDependencies?: Record<string, string>
}

function platformPackages(require: NodeJS.Require): string[] {
  try {
    // The SDK's `exports` map does not expose package.json, so it is read off
    // disk next to the entry point the resolver does hand back.
    const packageRoot = dirname(require.resolve(SDK_PACKAGE))
    const manifest = readJson<SdkManifest>(join(packageRoot, 'package.json'))
    if (!manifest.optionalDependencies) return []
    return Object.keys(manifest.optionalDependencies)
  } catch {
    return []
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The first executable of that name on PATH, or null when there is none. */
export function executableOnPath(name: string): string | null {
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const directory of directories) {
    for (const candidate of candidateNames(name)) {
      const full = join(directory, candidate)
      try {
        accessSync(full, constants.X_OK)
        return full
      } catch {
        continue
      }
    }
  }
  return null
}

/** Windows spells its executables with an extension; nothing else does. */
function candidateNames(name: string): string[] {
  if (process.platform !== 'win32') return [name]
  return [`${name}.cmd`, `${name}.exe`]
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
    private credentials: CredentialSource
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

  prompt(text: string): Promise<void> {
    if (!this.query) throw new Error('the Claude harness is not running')
    this.markRunning()
    this.queue.push(userMessage(text))
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
      env: await sessionEnvironment(this.options.provider, this.credentials),
      model: this.options.model ?? undefined,
      resume: this.options.resumeKey ?? undefined,
      includePartialMessages: true,
      maxThinkingTokens: budget === 0 ? undefined : budget,
      allowedTools: this.options.activeTools ?? undefined,
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
      this.report(message.parent_tool_use_id, toolResultEvents(message.message.content))
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

  constructor(private credentials: CredentialSource) {}

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
      this.cached = {
        tools: builtinTools(),
        commands: commandsOf(initialization.commands),
        skills: [],
        models: modelsOf(initialization.models, catalog, this.credentials),
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
  credentials: CredentialSource
): ModelEntry[] {
  const entries = new Map<string, ModelEntry>()
  for (const route of collectRoutes(models, catalog, credentials)) {
    addRoute(entries, route.key, route.label, route.route)
  }
  return [...entries.values()].sort(byNativeThenName)
}

interface KeyedRoute {
  key: string
  /** What to call the model this route reaches, if the route knows. */
  label: string | null
  route: ModelRoute
}

function collectRoutes(
  models: SdkModelInfo[],
  catalog: CatalogProvider[],
  credentials: CredentialSource
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
  return routes
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
    // An alias names itself, not the model, so it cannot name the entry. When
    // the CLI reports no wire model, the alias is all there is to go on.
    label: model.resolvedModel ? null : model.displayName,
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
 * File one route under its model, keeping at most one route per provider.
 *
 * A model reachable both through the account's own alias and through the
 * catalog's wire id is one route, not two: the alias is what the CLI blesses,
 * so it wins and the catalog's copy only fills in what it knows.
 */
function addRoute(
  entries: Map<string, ModelEntry>,
  key: string,
  label: string | null,
  route: ModelRoute
): void {
  const entry = entries.get(key)
  if (!entry) {
    entries.set(key, { key, label: label ?? route.label ?? key, routes: [route] })
    return
  }
  if (label && entry.label === entry.key) entry.label = label

  const existing = entry.routes.findIndex((candidate) => candidate.provider === route.provider)
  if (existing === -1) {
    entry.routes.push(route)
    return
  }
  entry.routes[existing] = mergeRoutes(entry.routes[existing], route)
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
  return id
    .replace(/^(?:us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+:\d+$/, '')
    .toLowerCase()
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

function credentialState(
  provider: CatalogProvider,
  credentials: CredentialSource
): ProviderCredential | undefined {
  if (provider.env.length === 0) return undefined
  return { env: provider.env, present: credentials.lookup(provider.env) !== null }
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
  credentials: CredentialSource
): Promise<Record<string, string | undefined> | undefined> {
  if (!provider || provider === PROVIDER) return undefined
  const entry = (await loadModelCatalog()).find((candidate) => candidate.id === provider)
  if (!entry) return undefined
  return { ...process.env, ...providerVariables(entry, credentials) }
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

/** The transcript events a user message carries: what the tools it ran answered. */
export function toolResultEvents(content: unknown): ServerEventBody[] {
  return blocksOf(content)
    .filter((block) => block.type === 'tool_result')
    .map((block) => ({
      type: 'agent.tool_result',
      toolUseId: String(block.tool_use_id),
      name: '',
      content: textOf(block.content),
      isError: block.is_error === true
    }))
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

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] }
  }
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

function createClaudeHarness(credentials: CredentialSource): HarnessDescriptor {
  const offering = new Offering(credentials)

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
      groveTools: true
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
      const run = new ClaudeRun(options, credentials)
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
  inject: ['harnesses', 'secrets'],

  apply(ctx: Context): void {
    // The secrets store is the credential source: it reads grove's environment
    // first and its own encrypted file second, so an exported key needs no UI.
    ctx.effect(() => ctx.harnesses.register(createClaudeHarness(ctx.secrets)), 'harness:claude')
  }
}
