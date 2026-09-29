// Bridges plugin AI contributions into agent runs. Plugin MCP tools are served
// beside grove's own tools, and each call proxies back into the plugin's worker.
// Skills append to the agent's system prompt. ai.prompt runs a standalone
// one-shot Claude Code session through switchboard that never touches the
// user's chat slots.

import type { Worktree } from '../../shared/types'
import type { PermissionBroker } from '../api/broker'
import type { ClientRecord } from '../api/clients'
import type { PluginRegistry } from './loader'
import { PermissionError } from '../api/broker'
import type { RequestPermissionRequest } from '@neoworks/harness'
import type { GroveTool } from '../agents/harness'
import type { SwitchboardHost } from '../agents/switchboard/host'

export interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface McpToolDeclaration {
  name: string
  description: string
  inputSchema: JsonSchemaObject
}

export interface McpServerDeclaration {
  name: string
  tools: McpToolDeclaration[]
}

export interface SkillDeclaration {
  name: string
  description: string
  instructions: string
}

const TOOL_CALL_TIMEOUT_MS = 30_000

interface PendingToolCall {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  pluginId: string
}

interface BridgeDeps {
  broker: PermissionBroker
  registry: PluginRegistry
  switchboard: SwitchboardHost
  send: (channel: string, payload: unknown) => void
}

// Tool kinds a one-shot prompt may use without asking: they only look.
const READ_ONLY_KINDS = new Set(['read', 'search', 'think', 'fetch'])

export class AiBridge {
  private deps: BridgeDeps
  private servers = new Map<string, Map<string, McpServerDeclaration>>()
  private skills = new Map<string, Map<string, SkillDeclaration>>()
  private pendingToolCalls = new Map<string, PendingToolCall>()
  private requestCounter = 0

  constructor(deps: BridgeDeps) {
    this.deps = deps
  }

  // ── Registration (from the api routes) ────────────────────────
  async registerMcpServer(client: ClientRecord, declaration: McpServerDeclaration): Promise<void> {
    await this.deps.broker.ensure(client, 'ai.mcp', `MCP server "${declaration.name}"`)
    const byName = this.servers.get(client.id) ?? new Map()
    byName.set(declaration.name, declaration)
    this.servers.set(client.id, byName)
  }

  disposeMcpServer(pluginId: string, name: string): void {
    this.servers.get(pluginId)?.delete(name)
  }

  async registerSkill(client: ClientRecord, skill: SkillDeclaration): Promise<void> {
    await this.deps.broker.ensure(client, 'ai.skills', `skill "${skill.name}"`)
    const byName = this.skills.get(client.id) ?? new Map()
    byName.set(skill.name, skill)
    this.skills.set(client.id, byName)
  }

  disposeSkill(pluginId: string, name: string): void {
    this.skills.get(pluginId)?.delete(name)
  }

  clearPlugin(pluginId: string): void {
    this.servers.delete(pluginId)
    this.skills.delete(pluginId)
    for (const [id, pending] of this.pendingToolCalls) {
      if (pending.pluginId !== pluginId) continue
      clearTimeout(pending.timer)
      pending.reject(new Error('plugin deactivated'))
      this.pendingToolCalls.delete(id)
    }
  }

  // ── Agent integration ─────────────────────────────────────────

  /**
   * Every tool a plugin registered, as grove tools agent runs are offered. A
   * plugin's tool is its own business, so it runs when called; the plugin was
   * granted `ai.mcp` to register it.
   */
  pluginTools(): GroveTool[] {
    const tools: GroveTool[] = []
    for (const [pluginId, byName] of this.servers) {
      for (const declaration of byName.values()) {
        for (const toolDeclaration of declaration.tools) {
          tools.push(this.pluginTool(pluginId, declaration.name, toolDeclaration))
        }
      }
    }
    return tools
  }

  private pluginTool(
    pluginId: string,
    serverName: string,
    toolDeclaration: McpToolDeclaration
  ): GroveTool {
    return {
      name: `${pluginId}_${serverName}_${toolDeclaration.name}`.replace(/[^A-Za-z0-9_-]/g, '_'),
      summary: toolDeclaration.description,
      description: toolDeclaration.description,
      inputSchema: toolDeclaration.inputSchema,
      policy: 'allow',
      execute: async (input) => {
        const result = await this.invokePluginTool(pluginId, toolDeclaration.name, input)
        return { content: textOfToolResult(result) }
      }
    }
  }

  // Skill blocks appended to the agent's system prompt (v1 mechanism; swaps
  // to native SDK skills when available).
  systemAppend(): string {
    const blocks: string[] = []
    for (const byName of this.skills.values()) {
      for (const skill of byName.values()) {
        blocks.push(`## Skill: ${skill.name}\n${skill.description}\n\n${skill.instructions}`)
      }
    }
    if (blocks.length === 0) return ''
    return `\n\n# Plugin-provided skills\n\n${blocks.join('\n\n')}`
  }

  // ── Tool proxy round trip (main → renderer host → plugin worker) ──
  private invokePluginTool(pluginId: string, toolName: string, input: unknown): Promise<unknown> {
    this.requestCounter += 1
    const id = `plugin-tool-${this.requestCounter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingToolCalls.delete(id)
        reject(new Error(`plugin tool "${toolName}" timed out`))
      }, TOOL_CALL_TIMEOUT_MS)
      this.pendingToolCalls.set(id, { resolve, reject, timer, pluginId })
      this.deps.send('event:plugin-tool-call', { id, pluginId, tool: toolName, input })
    })
  }

  respondToolCall(id: string, result: unknown, errorMessage?: string): void {
    const pending = this.pendingToolCalls.get(id)
    if (!pending) return
    this.pendingToolCalls.delete(id)
    clearTimeout(pending.timer)
    if (errorMessage) pending.reject(new Error(errorMessage))
    else pending.resolve(result)
  }

  // ── ai.prompt: standalone one-shot runs ───────────────────────
  // Streams switchboard's events through io.emit; resolves when the turn ends
  // and cancels on io.signal (the dispatcher owns cancellation). Tools that
  // change anything route through the plugin consent dialog; tools that only
  // look are allowed like agent runs.
  async runPrompt(
    client: ClientRecord,
    params: { prompt: string; model?: string; systemAppend?: string },
    worktree: Worktree,
    io: { emit: (chunk: unknown) => void; signal: AbortSignal }
  ): Promise<null> {
    await this.deps.broker.ensure(client, 'ai.prompt', truncate(params.prompt))
    const switchboard = await this.deps.switchboard.switchboard()
    const session = await switchboard.createSession({
      harness: 'claude',
      cwd: worktree.path,
      options: promptOptions(params),
      onPermission: async (request) => {
        const allowed = await this.allowPromptTool(client, request)
        if (allowed) return 'once'
        return 'reject'
      }
    })
    try {
      const run = session.prompt(params.prompt)
      const cancel = (): void => void session.cancel()
      io.signal.addEventListener('abort', cancel)
      if (io.signal.aborted) cancel()
      for await (const event of run) {
        let type: string = event.type
        if (event.type === 'update') type = event.update.sessionUpdate
        io.emit([{ type, payload: event }])
      }
      io.signal.removeEventListener('abort', cancel)
    } finally {
      await session.close()
    }
    return null
  }

  private async allowPromptTool(
    client: ClientRecord,
    request: RequestPermissionRequest
  ): Promise<boolean> {
    const kind = request.toolCall.kind
    if (kind && READ_ONLY_KINDS.has(kind)) return true
    const title = request.toolCall.title ?? 'tool call'
    const detail = `${title}: ${truncate(JSON.stringify(request.toolCall.rawInput ?? {}))}`
    try {
      await this.deps.broker.ensure(client, 'ai.prompt', detail)
      return true
    } catch (error) {
      if (error instanceof PermissionError) return false
      throw error
    }
  }
}

/** The switchboard options a plugin's one-shot prompt runs with. */
function promptOptions(params: { model?: string; systemAppend?: string }): {
  model?: string
  systemPrompt?: { append: string }
} {
  const options: { model?: string; systemPrompt?: { append: string } } = {}
  if (params.model) options.model = params.model
  if (params.systemAppend) options.systemPrompt = { append: params.systemAppend }
  return options
}

/** A plugin tool's answer as the text an agent reads. */
function textOfToolResult(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) {
    if (typeof result === 'string') return result
    return JSON.stringify(result ?? '')
  }
  return content
    .map((block: { type?: unknown; text?: unknown }) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return ''
    })
    .join('\n')
}

function truncate(text: string): string {
  if (text.length <= 200) return text
  return `${text.slice(0, 200)}…`
}
