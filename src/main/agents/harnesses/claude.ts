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
  ProviderModels,
  ServerEventBody,
  ThinkingLevel
} from '../../../shared/agents'
import { zodShapeFromJsonSchema, type JsonSchemaObject } from '../../plugins/zodSchema'
import type {
  GroveTool,
  HarnessDescriptor,
  HarnessOffering,
  HarnessRun,
  HarnessRunOptions,
  ToolIntent
} from '../harness'

const HARNESS_ID = 'claude'

// Claude Code talks to one provider, so every model it lists is grouped under
// this one in the picker's provider → model cascade.
const PROVIDER = 'anthropic'

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

  constructor(private options: HarnessRunOptions) {
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
    this.options.emit({ type: 'session.status_running' })
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
    this.options.emit({ type: 'session.status_running' })
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
      model: this.options.model ?? undefined,
      resume: this.options.resumeKey ?? undefined,
      includePartialMessages: true,
      maxThinkingTokens: budget === 0 ? undefined : budget,
      allowedTools: this.options.activeTools ?? undefined,
      mcpServers: await this.groveServer(),
      canUseTool: async (name, input, { toolUseID }) => {
        const decision = await this.options.confirm({ toolUseId: toolUseID, name, input })
        if (allows(decision.result)) return { behavior: 'allow', updatedInput: input }
        return { behavior: 'deny', message: decision.reason ?? 'denied by the user' }
      }
    }
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
            this.options.emit({ type: 'ui.surface', surfaceId, slot, view } as ServerEventBody)
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
    if (message.type === 'stream_event') {
      this.handleStreamEvent(message.event)
      return
    }
    if (message.type === 'assistant') {
      this.handleAssistant(message.message.content)
      return
    }
    if (message.type === 'user') {
      this.handleToolResults(message.message.content)
      return
    }
    if (message.type === 'result') this.handleResult(message)
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

  /** Partial messages carry the deltas the transcript streams. */
  private handleStreamEvent(rawEvent: unknown): void {
    const event = rawEvent as { type: string; delta?: Record<string, unknown> }
    if (event.type === 'message_start') {
      this.options.emit({ type: 'agent.message_start' })
      return
    }
    if (event.type !== 'content_block_delta') return
    const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined
    if (delta?.type === 'text_delta' && delta.text) {
      this.options.emit({ type: 'agent.message_delta', text: delta.text })
    }
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      this.options.emit({ type: 'agent.thinking_delta', text: delta.thinking })
    }
  }

  private handleAssistant(content: unknown): void {
    const blocks = blocksOf(content)
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      this.options.emit({
        type: 'agent.tool_use',
        toolUseId: String(block.id),
        name: String(block.name),
        input: block.input,
        permission: 'allow'
      })
    }
    this.options.emit({
      type: 'agent.message_end',
      content: blocks as ContentBlock[],
      stopReason: 'end_turn'
    })
  }

  private handleToolResults(content: unknown): void {
    for (const block of blocksOf(content)) {
      if (block.type !== 'tool_result') continue
      this.options.emit({
        type: 'agent.tool_result',
        toolUseId: String(block.tool_use_id),
        name: '',
        content: textOf(block.content),
        isError: block.is_error === true
      })
    }
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

/** Probe the SDK once for what it can offer, and remember the answer. */
class Offering {
  private cached: HarnessOffering | null = null
  private inflight: Promise<HarnessOffering> | null = null

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
      this.cached = {
        tools: [],
        commands: commandsOf(initialization.commands),
        skills: [],
        providers: providersOf(initialization.models),
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

function commandsOf(commands: SlashCommand[]): CommandInfo[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    kind: 'command'
  }))
}

function providersOf(models: SdkModelInfo[]): ProviderModels[] {
  if (models.length === 0) return []
  return [
    {
      provider: PROVIDER,
      models: models.map((model) => ({
        id: model.value,
        provider: PROVIDER,
        label: model.displayName
      }))
    }
  ]
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

function createClaudeHarness(): HarnessDescriptor {
  const offering = new Offering()

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
      const run = new ClaudeRun(options)
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
  inject: ['harnesses'],

  apply(ctx: Context): void {
    ctx.effect(() => ctx.harnesses.register(createClaudeHarness()), 'harness:claude')
  }
}
