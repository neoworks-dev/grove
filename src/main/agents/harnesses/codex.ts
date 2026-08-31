// The OpenAI Codex SDK, as a grove harness.
//
// The SDK drives the `codex` CLI: a thread is a conversation, `runStreamed` is
// one turn of it, and the events it yields are whole items rather than token
// deltas. Codex decides its own tool approvals from the sandbox and approval
// policy it was started with, so there is no callback to hold a write at —
// grove reviews Codex's changes after they land, from the file watcher.

import { spawn } from 'node:child_process'
import type { Context } from '@neoworks/extension-system'
import type { Codex, Thread, ThreadEvent, ThreadItem } from '@openai/codex-sdk'
import type {
  ProviderModels,
  ServerEventBody,
  ThinkingLevel,
  UiNode
} from '../../../shared/agents'
import type { HarnessDescriptor, HarnessRun, HarnessRunOptions } from '../harness'

const HARNESS_ID = 'codex'

// Codex reaches OpenAI's models only, so they all group under this one provider
// in the picker's provider → model cascade.
const PROVIDER = 'openai'

// The surface the to-do list is published under; one per session, replaced as
// the plan changes rather than appended to the transcript over and over.
const TODO_SURFACE_ID = 'codex.todo'

/** grove's thinking levels mapped onto Codex's reasoning efforts. */
const REASONING_EFFORT: Record<ThinkingLevel, string | undefined> = {
  off: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max'
}

class CodexRun implements HarnessRun {
  resumeKey: string | null
  private thread: Thread | null = null
  private turn: AbortController | null = null

  constructor(
    private options: HarnessRunOptions,
    private codex: Codex
  ) {
    this.resumeKey = options.resumeKey
  }

  /** Open the thread, resuming the previous one when grove has its id. */
  start(): void {
    const threadOptions = {
      workingDirectory: this.options.workspaceRoot,
      model: this.options.model ?? undefined,
      modelReasoningEffort: REASONING_EFFORT[this.options.thinkingLevel],
      skipGitRepoCheck: true
    } as Parameters<Codex['startThread']>[0]

    this.thread = this.resumeKey
      ? this.codex.resumeThread(this.resumeKey, threadOptions)
      : this.codex.startThread(threadOptions)
  }

  async prompt(text: string): Promise<void> {
    const thread = this.thread
    if (!thread) throw new Error('the Codex harness is not running')

    const controller = new AbortController()
    this.turn = controller
    this.options.emit({ type: 'session.status_running' })

    try {
      const streamed = await thread.runStreamed(text, { signal: controller.signal })
      for await (const event of streamed.events) this.handle(event)
    } catch (cause) {
      if (!controller.signal.aborted) {
        this.options.emit({ type: 'session.error', message: (cause as Error).message })
      }
      this.options.emit({
        type: 'session.status_idle',
        stopReason: controller.signal.aborted ? 'aborted' : 'error'
      })
    } finally {
      this.turn = null
      this.resumeKey = thread.id ?? this.resumeKey
    }
  }

  interrupt(): Promise<void> {
    this.turn?.abort()
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    this.turn?.abort()
    this.thread = null
    return Promise.resolve()
  }

  // ── Events ──────────────────────────────────────────────────────

  private handle(event: ThreadEvent): void {
    if (event.type === 'thread.started') {
      this.resumeKey = event.thread_id
      return
    }
    if (event.type === 'item.started' || event.type === 'item.updated') {
      this.handleItemProgress(event.item)
      return
    }
    if (event.type === 'item.completed') {
      this.handleItemCompleted(event.item)
      return
    }
    if (event.type === 'turn.completed') {
      this.options.stats({
        usage: {
          inputTokens: event.usage.input_tokens,
          outputTokens: event.usage.output_tokens,
          cacheReadTokens: event.usage.cached_input_tokens,
          cacheWriteTokens: event.usage.cache_write_input_tokens
        },
        cost: 0,
        contextWindow: 0
      })
      this.options.emit({ type: 'session.status_idle', stopReason: 'end_turn' })
      return
    }
    if (event.type === 'turn.failed') {
      this.options.emit({ type: 'session.error', message: event.error.message })
      this.options.emit({ type: 'session.status_idle', stopReason: 'error' })
      return
    }
    if (event.type === 'error') {
      this.options.emit({ type: 'session.error', message: event.message })
    }
  }

  /** A started or updated item: announce the call, then stream what it reports. */
  private handleItemProgress(item: ThreadItem): void {
    const call = toolCallOf(item)
    if (!call) return
    this.options.emit({
      type: 'agent.tool_use',
      toolUseId: item.id,
      name: call.name,
      input: call.input,
      permission: 'allow'
    })
    if (call.progress) {
      this.options.emit({
        type: 'agent.tool_progress',
        toolUseId: item.id,
        name: call.name,
        message: call.progress
      })
    }
  }

  private handleItemCompleted(item: ThreadItem): void {
    if (item.type === 'agent_message') {
      this.emitMessage(item.text)
      return
    }
    if (item.type === 'reasoning') {
      this.options.emit({ type: 'agent.thinking_delta', text: item.text })
      return
    }
    if (item.type === 'todo_list') {
      this.emitTodoList(item.items)
      return
    }
    if (item.type === 'error') {
      this.options.emit({ type: 'session.error', message: item.message })
      return
    }

    const call = toolCallOf(item)
    if (!call) return
    this.options.emit({
      type: 'agent.tool_result',
      toolUseId: item.id,
      name: call.name,
      content: call.result ?? '',
      isError: call.isError === true
    })
  }

  /**
   * Codex reports a finished message rather than deltas, so the transcript gets
   * the whole thing in one go — the fold is the same either way.
   */
  private emitMessage(text: string): void {
    this.options.emit({ type: 'agent.message_start' })
    this.options.emit({ type: 'agent.message_delta', text })
    this.options.emit({
      type: 'agent.message_end',
      content: [{ type: 'text', text }],
      stopReason: 'end_turn'
    })
  }

  private emitTodoList(items: { text: string; completed: boolean }[]): void {
    const view: UiNode = {
      kind: 'list',
      items: items.map((item) => `${item.completed ? '✓' : '○'} ${item.text}`),
      fallbackText: items.map((item) => item.text).join('\n')
    }
    this.options.emit({
      type: 'ui.surface',
      surfaceId: TODO_SURFACE_ID,
      slot: 'panel',
      view
    } as ServerEventBody)
  }
}

interface ToolCall {
  name: string
  input: Record<string, unknown>
  progress?: string
  result?: string
  isError?: boolean
}

/** Codex items that read as tool calls, mapped onto grove's tool vocabulary. */
function toolCallOf(item: ThreadItem): ToolCall | null {
  if (item.type === 'command_execution') {
    return {
      name: 'shell',
      input: { command: item.command },
      progress: item.aggregated_output,
      result: item.aggregated_output,
      isError: item.status === 'failed'
    }
  }
  if (item.type === 'file_change') {
    return {
      name: 'apply_patch',
      input: { changes: item.changes },
      result: item.changes.map((change) => `${change.kind} ${change.path}`).join('\n'),
      isError: item.status === 'failed'
    }
  }
  if (item.type === 'mcp_tool_call') {
    return {
      name: `${item.server}__${item.tool}`,
      input: (item.arguments as Record<string, unknown>) ?? {},
      result: item.error ? item.error.message : summarize(item.result),
      isError: item.error !== undefined
    }
  }
  if (item.type === 'web_search') {
    return { name: 'web_search', input: { query: item.query }, result: item.query }
  }
  return null
}

function summarize(result: { content: unknown[] } | undefined): string {
  if (!result) return ''
  return result.content.map(blockText).join('')
}

function blockText(block: unknown): string {
  const typed = block as { type?: string; text?: string }
  if (typed.type !== 'text' || typed.text === undefined) return ''
  return typed.text
}

/**
 * The model catalog, read off the CLI's app-server protocol.
 *
 * The Codex SDK has no endpoint that enumerates models, but the CLI's
 * `app-server` does: one `model/list` request over stdio answers with the same
 * catalog the interactive picker shows. Asking it means grove never has to keep
 * a list of OpenAI model ids of its own.
 */
function listCodexModels(): Promise<CodexModel[]> {
  return appServerRequest<{ data: CodexModel[] }>('model/list', {}).then(
    (response) => response.data
  )
}

interface CodexModel {
  id: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
}

// How long to give `codex app-server` to answer before giving up on the
// catalog. It only has to start and reply; it never runs a turn.
const APP_SERVER_TIMEOUT_MS = 30_000

/**
 * Run one JSON-RPC request against a throwaway `codex app-server`.
 *
 * The server speaks newline-delimited JSON-RPC on stdio and requires an
 * `initialize` handshake before anything else, so both are done here and the
 * process is torn down as soon as the answer arrives.
 */
function appServerRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const server = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => finish(new Error(`codex ${method} timed out`)), APP_SERVER_TIMEOUT_MS)

    function finish(error: Error | null, value?: T): void {
      clearTimeout(timer)
      server.kill()
      if (error) reject(error)
      else resolve(value as T)
    }

    function send(message: Record<string, unknown>): void {
      server.stdin.write(`${JSON.stringify(message)}\n`)
    }

    server.on('error', (cause) => finish(cause))
    readJsonLines(server.stdout, (message) => {
      if (message.id === 1) {
        send({ jsonrpc: '2.0', method: 'initialized' })
        send({ jsonrpc: '2.0', id: 2, method, params })
        return
      }
      if (message.id !== 2) return
      if (message.error) finish(new Error(String(message.error.message ?? `codex ${method} failed`)))
      else finish(null, message.result as T)
    })

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'grove', version: '0' } }
    })
  })
}

interface JsonRpcMessage {
  id?: number
  result?: unknown
  error?: { message?: unknown }
}

/** Fold a stdout stream into whole newline-delimited JSON messages. */
export function readJsonLines(
  stream: NodeJS.ReadableStream,
  onMessage: (message: JsonRpcMessage) => void
): void {
  let buffered = ''
  stream.on('data', (chunk: Buffer) => {
    buffered += chunk.toString()
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      const message = parseMessage(line)
      if (message) onMessage(message)
    }
  })
}

/** One line of the stream, or null when it is not a protocol message. */
function parseMessage(line: string): JsonRpcMessage | null {
  if (!line.trim()) return null
  try {
    return JSON.parse(line)
  } catch {
    // The server interleaves diagnostics that are not protocol messages.
    return null
  }
}

/** Is the `codex` CLI on PATH? The SDK spawns it, so nothing works without it. */
function codexInstalled(): Promise<{ available: boolean; detail: string | null }> {
  return new Promise((resolve) => {
    const probe = spawn('codex', ['--version'], { stdio: 'ignore' })
    probe.on('error', () =>
      resolve({ available: false, detail: 'the codex CLI is not on PATH — install @openai/codex' })
    )
    probe.on('exit', (code) =>
      resolve(
        code === 0
          ? { available: true, detail: null }
          : { available: false, detail: `codex --version exited with ${code}` }
      )
    )
  })
}

/** Every provider Codex can reach is OpenAI's, so the cascade has one row. */
function providersOf(models: CodexModel[]): ProviderModels[] {
  if (models.length === 0) return []
  return [
    {
      provider: PROVIDER,
      models: models.map((model) => ({
        id: model.id,
        provider: PROVIDER,
        label: model.displayName
      }))
    }
  ]
}

function defaultModelOf(models: CodexModel[]): { provider: string; model: string } | null {
  const chosen = models.find((model) => model.isDefault) ?? models[0]
  if (!chosen) return null
  return { provider: PROVIDER, model: chosen.id }
}

function createCodexHarness(): HarnessDescriptor {
  let client: Codex | null = null
  let models: Promise<CodexModel[]> | null = null

  /**
   * The catalog, fetched once. A failure is not cached, so a picker opened
   * again after logging in gets a second chance.
   */
  function offeringModels(): Promise<CodexModel[]> {
    if (models === null) {
      models = listCodexModels()
        .then((listed) => listed.filter((model) => !model.hidden))
        .catch(() => {
          models = null
          return []
        })
    }
    return models
  }

  async function codex(): Promise<Codex> {
    if (client) return client
    const { Codex: CodexClient } = await import('@openai/codex-sdk')
    client = new CodexClient()
    return client
  }

  return {
    id: HARNESS_ID,
    label: 'Codex',
    description: "OpenAI's Codex SDK, driving the codex CLI in a sandboxed thread.",
    icon: 'grove:codex',
    capabilities: {
      approvals: false,
      interrupt: true,
      liveModelSwitch: false,
      thinking: true,
      steering: false,
      groveTools: false
    },

    probe: codexInstalled,

    /**
     * Codex exposes no tools, commands or skills to enumerate, so the approval
     * card falls back to raw input and the composer offers no completions.
     * Models it does have, via the app-server catalog, and they are cached
     * because the answer costs a process start.
     */
    async offering() {
      const models = await offeringModels()
      return {
        tools: [],
        commands: [],
        skills: [],
        providers: providersOf(models),
        default: defaultModelOf(models)
      }
    },

    async start(options: HarnessRunOptions) {
      const run = new CodexRun(options, await codex())
      run.start()
      return run
    },

    /**
     * Codex applies patches itself and reports them once they are on disk, so
     * there is nothing for the review flow to hold. Its changes are reviewed
     * after the fact, from the file watcher.
     */
    intentOf() {
      return null
    }
  }
}

export const codexHarness = {
  name: 'main/harness/codex',
  inject: ['harnesses'],

  apply(ctx: Context): void {
    ctx.effect(() => ctx.harnesses.register(createCodexHarness()), 'harness:codex')
  }
}
