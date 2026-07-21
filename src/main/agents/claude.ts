// Claude adapter — Anthropic Agent SDK. Uses `query()` which streams SDK
// messages (same shape as the CLI stream-json) and exposes `canUseTool`, the
// callback that pauses the run until the user approves or denies a tool. This
// is the only adapter with true interactive permissions.

// The SDK is ESM-only; the Electron main is CommonJS with externalized deps, so
// it must be loaded via dynamic import() (require() of an ESM package throws).
import { isAbsolute, resolve } from 'path'
import type { PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConfig, AgentOption, AgentSlashCommand } from '../../shared/types'
import type { AdapterContext, AgentAdapter, RunHandle } from './types'
import { textLine } from './types'
import { zodShapeFromJsonSchema } from '../plugins/zodSchema'

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

// Build the in-process `grove-chat` MCP server exposing sendMessage/readMessages
// so the model can talk to sibling agents and the user. Handlers close over this
// run's channel binding, so the sender identity is set by the manager, not the
// model.
function buildChatServer(sdk: SdkModule, chat: NonNullable<AdapterContext['chat']>): unknown {
  const text = (value: string): { content: { type: 'text'; text: string }[] } => ({
    content: [{ type: 'text', text: value }]
  })
  return sdk.createSdkMcpServer({
    name: 'grove-chat',
    tools: [
      sdk.tool(
        'sendMessage',
        'Send a chat message to the other agents and the user working in this worktree. Optionally target one agent by name via "to".',
        zodShapeFromJsonSchema({
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message to send.' },
            to: { type: 'string', description: 'Optional agent name to address.' }
          },
          required: ['text']
        }),
        async (input: unknown) => {
          const data = (input || {}) as { text?: string; to?: string }
          if (data.text) chat.send(data.text, data.to)
          return text('Message sent.')
        }
      ),
      sdk.tool(
        'readMessages',
        'Read recent chat messages from the other agents and the user in this worktree.',
        zodShapeFromJsonSchema({
          type: 'object',
          properties: {
            since: { type: 'number', description: 'Only messages after this epoch-ms timestamp.' }
          }
        }),
        async (input: unknown) => {
          const data = (input || {}) as { since?: number }
          const messages = chat.history(data.since)
          if (messages.length === 0) return text('No messages yet.')
          return text(
            messages.map((message) => `[${message.from.name}] ${message.text}`).join('\n')
          )
        }
      )
    ]
  })
}

export const INTRO_PHASES = ['explore', 'interview', 'example', 'feedback', 'config', 'done']

// Build the in-process `grove-intro` MCP server for AGENTS.md onboarding runs.
// One tool: setPhase, so the intro pane's stepper can follow the protocol.
function buildIntroServer(sdk: SdkModule, intro: NonNullable<AdapterContext['intro']>): unknown {
  return sdk.createSdkMcpServer({
    name: 'grove-intro',
    tools: [
      sdk.tool(
        'setPhase',
        'Report the current onboarding phase so the introduction page can show progress.',
        zodShapeFromJsonSchema({
          type: 'object',
          properties: {
            phase: {
              type: 'string',
              enum: INTRO_PHASES,
              description: 'The onboarding phase you are entering.'
            }
          },
          required: ['phase']
        }),
        async (input: unknown) => {
          const data = (input || {}) as { phase?: string }
          if (data.phase && INTRO_PHASES.includes(data.phase)) intro.setPhase(data.phase)
          return { content: [{ type: 'text' as const, text: 'Phase updated.' }] }
        }
      )
    ]
  })
}

const config: AgentConfig = {
  command: 'claude',
  interactive: true,
  // Permission modes map to the SDK's PermissionMode values.
  modes: [
    { label: 'manual review', value: 'default' },
    { label: 'plan', value: 'plan' },
    { label: 'accept edits', value: 'acceptEdits' },
    { label: 'auto', value: 'bypassPermissions' }
  ],
  // Reasoning effort levels (SDK `effort` option). The picker defaults to 'high'
  // (see defaultEffortIndex in the renderer). `xhigh`/`max` only apply on models
  // that support them; others silently downgrade.
  efforts: [
    { label: 'low', value: 'low' },
    { label: 'medium', value: 'medium' },
    { label: 'high', value: 'high' },
    { label: 'xhigh', value: 'xhigh' },
    { label: 'max', value: 'max' }
  ]
  // Models are discovered at runtime via the SDK's supportedModels() control
  // request (see reportModels in start), so no static list is declared here.
}

// Read-only tools auto-approved in every mode — they cannot mutate the
// worktree, so routing them through the permission prompt is pure friction.
// These are approved inside canUseTool (not via `allowedTools`): a bare
// `allowedTools` entry auto-approves the tool BEFORE canUseTool runs, which
// shadows the callback (the SDK warns about this) and means we can't gate
// subagent tool calls. Approving here keeps the callback authoritative.
const alwaysAllowedTools = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  // Let the model spawn subagents without a prompt; the subagent's own tools
  // still route through this callback and prompt as usual.
  'Task'
])

// Read-only Bash commands auto-approved by leading executable. Only an exact
// program match at the start of the command line counts.
const alwaysAllowedBash = ['grep', 'rg', 'ls', 'cat', 'find', 'head', 'tail', 'wc']

function isReadOnlyBash(input: Record<string, unknown>): boolean {
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!command) return false
  const program = command.split(/\s+/)[0]
  return alwaysAllowedBash.includes(program)
}

function isAutoAllowed(toolName: string, input: Record<string, unknown>): boolean {
  if (alwaysAllowedTools.has(toolName)) return true
  if (toolName === 'Bash') return isReadOnlyBash(input)
  return false
}

function filePathOf(input: Record<string, unknown>): string | null {
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  return null
}

// File-mutating tools whose target must be locked before the edit runs.
// MultiEdit targets a single file_path (with many edits); NotebookEdit uses
// notebook_path.
const fileWriteTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// Absolute, normalized target path(s) of a file-write tool, for locking.
// Resolving relative paths against the worktree cwd collapses ./ and ../ so an
// alternate spelling of the same file can't slip past the lock.
function lockTargets(input: Record<string, unknown>, cwd: string): string[] {
  const raw =
    filePathOf(input) || (typeof input.notebook_path === 'string' ? input.notebook_path : null)
  if (!raw) return []
  return [isAbsolute(raw) ? raw : resolve(cwd, raw)]
}

// Render the user's dialog answer as readable text for the model. The dialog
// result carries `answers` (question → chosen label[s]) plus optional free-form
// `notes`.
function formatDialogAnswer(result: unknown): string {
  const data = (result || {}) as { answers?: Record<string, string>; notes?: string }
  const lines: string[] = []
  for (const [question, answer] of Object.entries(data.answers || {})) {
    if (answer && answer.trim()) lines.push(`- ${question}: ${answer.trim()}`)
  }
  if (data.notes && data.notes.trim()) lines.push(`- Additional notes: ${data.notes.trim()}`)
  if (lines.length === 0) return 'The user acknowledged the question without selecting an option.'
  return `The user answered your question(s):\n${lines.join('\n')}`
}

// Push-buffer async generator feeding the SDK's streaming-input mode. Messages
// pushed while a turn runs are injected into the conversation; closing the
// queue lets the current turn finish and then ends the run.
interface InputQueue {
  push: (text: string) => boolean
  close: () => void
  pendingCount: () => number
  stream: () => AsyncGenerator<SDKUserMessage>
}

function createInputQueue(): InputQueue {
  const buffer: SDKUserMessage[] = []
  let closed = false
  let notify: (() => void) | null = null

  function push(text: string): boolean {
    if (closed) return false
    buffer.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null
    })
    notify?.()
    return true
  }

  function close(): void {
    closed = true
    notify?.()
  }

  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (buffer.length > 0) yield buffer.shift()!
      if (closed) return
      await new Promise<void>((resolve) => {
        notify = resolve
      })
      notify = null
    }
  }

  return { push, close, pendingCount: () => buffer.length, stream }
}

function start(context: AdapterContext): RunHandle {
  const abort = new AbortController()
  const permissionMode = context.options.mode || 'default'
  const input = createInputQueue()
  let run: { interrupt: () => Promise<void> } | null = null

  void (async () => {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk')
      const { query } = sdk
      // Plugin-contributed MCP servers (in-process, handlers proxied to the
      // plugin workers) and skill text.
      const pluginMcpServers = context.pluginAi ? await context.pluginAi.mcpServers() : {}
      const skillAppend = context.pluginAi ? context.pluginAi.systemAppend() : ''
      // Built-in worktree chat channel, merged alongside plugin servers.
      const mcpServers: Record<string, unknown> = { ...pluginMcpServers }
      if (context.chat) mcpServers['grove-chat'] = buildChatServer(sdk, context.chat)
      if (context.intro) mcpServers['grove-intro'] = buildIntroServer(sdk, context.intro)
      const launchAppend = context.options.appendSystemPrompt || ''
      const systemAppend = [skillAppend, launchAppend].filter(Boolean).join('\n\n')
      // Streaming-input mode: the prompt rides in as the first queued message,
      // and later sends inject into the live conversation. It also unlocks the
      // SDK's control requests (interrupt, supportedCommands).
      input.push(context.options.prompt || '')
      const iterator = query({
        prompt: input.stream(),
        options: {
          cwd: context.worktree.path,
          abortController: abort,
          mcpServers: Object.keys(mcpServers).length > 0 ? (mcpServers as never) : undefined,
          // Use Claude Code's default system prompt so its dynamic auto-memory
          // section loads CLAUDE.md, and load project settings so that memory
          // (and .claude settings) is actually read from disk.
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: systemAppend || undefined
          },
          settingSources: ['user', 'project', 'local'],
          // Resume the prior conversation when we have its session id.
          resume: context.resume || undefined,
          permissionMode: permissionMode as
            'default' | 'plan' | 'acceptEdits' | 'bypassPermissions',
          model: context.options.model || undefined,
          effort:
            (context.options.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max') || undefined,
          includePartialMessages: false,
          stderr: (data: string) => context.emit(textLine('stderr', data)),
          // MUST declare the dialog kinds we render, or the CLI emits none at
          // all (fails closed) and onUserDialog never fires. `side_question` is
          // the AskUserQuestion dialog.
          supportedDialogKinds: ['side_question', 'sdk_side_question'],
          // Blocking dialogs (agent questions etc.) — surfaced to the user and
          // answered. Without this, the CLI auto-cancels them and the question
          // is never shown. The payload/result shapes are SDK-defined per kind.
          onUserDialog: async (request) => {
            // eslint-disable-next-line no-console
            console.error('[agent-dialog]', request.dialogKind, JSON.stringify(request.payload))
            const decision = await context.requestDialog({
              worktreeId: context.worktree.id,
              agent: 'claude',
              dialogKind: request.dialogKind,
              payload: request.payload
            })
            if (decision.behavior === 'completed') {
              return { behavior: 'completed', result: decision.result }
            }
            return { behavior: 'cancelled' }
          },
          canUseTool: async (toolName, input, options): Promise<PermissionResult> => {
            // AskUserQuestion is the model asking the user — the questions ride in
            // `input`. Surface them as a chooser and feed the answer back. (The
            // answer returns via deny-with-message: the only canUseTool channel
            // that delivers text to the model, which reads it as the reply.)
            if (toolName === 'AskUserQuestion') {
              const dialog = await context.requestDialog({
                worktreeId: context.worktree.id,
                agent: 'claude',
                dialogKind: 'askUserQuestion',
                payload: input
              })
              if (dialog.behavior === 'cancelled') {
                return {
                  behavior: 'deny',
                  message: 'The user dismissed the question without answering.'
                }
              }
              return { behavior: 'deny', message: formatDialogAnswer(dialog.result) }
            }
            // Read-only tools skip the prompt in every mode.
            if (isAutoAllowed(toolName, input)) {
              return { behavior: 'allow', updatedInput: input }
            }
            // Cross-agent edit coordination: claim the target file before a
            // mutating edit. If another agent in this worktree holds it, deny
            // with a message so the model works elsewhere and retries later.
            if (context.tryAcquireLocks && fileWriteTools.has(toolName)) {
              const targets = lockTargets(input, context.worktree.path)
              if (targets.length > 0) {
                const lock = context.tryAcquireLocks(targets)
                if (!lock.ok) {
                  return {
                    behavior: 'deny',
                    message: `${targets[0]} is currently being edited by another agent${
                      lock.heldBy ? ` (${lock.heldBy})` : ''
                    }. Do not edit it now — work on a different file, or wait and try this edit again later.`
                  }
                }
              }
            }
            const decision = await context.requestPermission({
              worktreeId: context.worktree.id,
              agent: 'claude',
              toolName,
              title: options.title || `Claude wants to use ${toolName}`,
              path: options.blockedPath || filePathOf(input),
              input
            })
            if (decision.behavior === 'allow') {
              const result: PermissionResult = { behavior: 'allow', updatedInput: input }
              // "Remember" reuses the SDK's own suggested permission rules.
              if (decision.remember && options.suggestions) {
                result.updatedPermissions = options.suggestions
              }
              return result
            }
            return { behavior: 'deny', message: decision.message }
          }
        }
      })
      run = iterator

      // Discovered slash commands: the init message only carries names, so ask
      // the control channel for the full list (descriptions + argument hints).
      function reportCommands(): void {
        void iterator
          .supportedCommands()
          .then((commands) => {
            const list: AgentSlashCommand[] = commands.map((command) => ({
              name: command.name,
              description: command.description,
              argumentHint: command.argumentHint
            }))
            context.setCommands?.(list)
          })
          .catch(() => {})
      }


      for await (const message of iterator) {
        // Capture the session id (carried on system/init and result messages)
        // so the next turn resumes this conversation.
        const sessionId = (message as { session_id?: string }).session_id
        if (sessionId) context.setSession(sessionId)
        if (message.type === 'system' && message.subtype === 'init') {
          reportCommands()
        }
        if (message.type === 'system' && message.subtype === 'commands_changed') {
          const changed = (message as { commands?: AgentSlashCommand[] }).commands
          if (changed) {
            context.setCommands?.(
              changed.map(({ name, description, argumentHint }) => ({
                name,
                description,
                argumentHint
              }))
            )
          }
        }
        // Turn finished with nothing else queued: close the input stream so the
        // run exits like the old one-shot mode. A send racing this close gets
        // `false` back and the manager queues it instead. (If some flows emit
        // `result` while still expecting input, switch this to close on
        // `session_state_changed` with state 'idle'.)
        if (message.type === 'result' && input.pendingCount() === 0) {
          input.close()
        }
        // Release this run's file locks at each turn boundary so a paused
        // collaborator can proceed once we're done editing.
        if (message.type === 'result') {
          context.releaseLocks?.()
        }
        context.emit(JSON.stringify(message))
      }
      context.setStatus('exited', 0)
    } catch (error) {
      if (abort.signal.aborted) {
        context.setStatus('stopped')
        return
      }
      context.emit(textLine('error', `[error] ${(error as Error).message}`))
      context.setStatus('error', 1)
    }
  })()

  return {
    send: (text) => input.push(text),
    stop: async () => {
      input.close()
      abort.abort()
      try {
        await run?.interrupt()
      } catch {
        // already terminated
      }
    }
  }
}

// The available model list is fetched straight from the Agent SDK via a
// short-lived probe query that only issues the `supportedModels()` control
// request (no user turn, so no tokens spent). Cached for the process lifetime —
// the list is per Claude Code build, not per worktree.
let modelsProbe: Promise<AgentOption[]> | null = null

async function listModels(cwd: string): Promise<AgentOption[]> {
  if (!modelsProbe) modelsProbe = probeModels(cwd).catch(() => [])
  return modelsProbe
}

async function probeModels(cwd: string): Promise<AgentOption[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const abort = new AbortController()
  const input = createInputQueue()
  try {
    const iterator = query({
      // Streaming-input mode (an open prompt stream) is what unlocks control
      // requests like supportedModels(); we never push a turn.
      prompt: input.stream(),
      options: { cwd, abortController: abort }
    })
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('supportedModels timed out')), 15000)
    )
    const models = await Promise.race([iterator.supportedModels(), timeout])
    const options: AgentOption[] = []
    const seen = new Set<string>()
    for (const model of models) {
      // Skip Claude Code's "Default"/recommended pseudo-rows — the picker lists
      // concrete, versioned models only.
      if (!model.value || /default|recommended/i.test(model.displayName)) continue
      const label = modelLabel(model)
      // Collapse duplicates (e.g. an alias row and its explicit wire-id row that
      // resolve to the same model) by their display label.
      if (seen.has(label)) continue
      seen.add(label)
      options.push({ label, value: model.value })
    }
    return options
  } finally {
    input.close()
    abort.abort()
  }
}

// Build a versioned label. Claude Code's displayName is often just the family
// ("Opus"); the version lives on resolvedModel ("claude-opus-4-8" → "Opus 4.8").
function modelLabel(model: { displayName: string; value: string; resolvedModel?: string }): string {
  if (/\d/.test(model.displayName)) return model.displayName
  const wire = model.resolvedModel || model.value
  const [family, ...version] = wire.replace(/^claude-/, '').split('-')
  const title = family.charAt(0).toUpperCase() + family.slice(1)
  if (version.length === 0) return model.displayName || title
  return `${title} ${version.join('.')}`
}

export const claudeAdapter: AgentAdapter = { name: 'claude', config, start, listModels }
