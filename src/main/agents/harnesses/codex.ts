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
import type { ServerEventBody, ThinkingLevel, UiNode } from '../../../shared/agents'
import type { HarnessDescriptor, HarnessRun, HarnessRunOptions } from '../harness'

const HARNESS_ID = 'codex'

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

function createCodexHarness(): HarnessDescriptor {
  let client: Codex | null = null

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
     * Codex has no endpoint that enumerates models or commands, so the model is
     * whatever the user types and the composer offers no completions. Nothing is
     * invented here: an empty catalog is the honest answer.
     */
    offering() {
      return Promise.resolve({
        tools: [],
        commands: [],
        skills: [],
        providers: [],
        default: null
      })
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
