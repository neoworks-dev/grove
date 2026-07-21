// Bridges plugin AI contributions into agent runs. Plugin MCP tools run
// in-process in main via the agent SDK's SDK-MCP transport — the tool handler
// proxies back into the plugin's worker (no child processes). Skills append
// to the agent's system prompt. ai.prompt runs a standalone one-shot query
// that never touches the user's chat slots.

import type { Worktree } from '../../shared/types'
import type { PermissionBroker } from '../api/broker'
import type { ClientRecord } from '../api/clients'
import type { PluginRegistry } from './loader'
import { PermissionError } from '../api/broker'
import { zodShapeFromJsonSchema, type JsonSchemaObject } from './zodSchema'

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
  send: (channel: string, payload: unknown) => void
}

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

  // ── Adapter integration ───────────────────────────────────────
  // Build SDK-MCP server configs for every registered plugin server.
  async buildMcpServers(): Promise<Record<string, unknown>> {
    if (this.servers.size === 0) return {}
    const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
    const configs: Record<string, unknown> = {}
    for (const [pluginId, byName] of this.servers) {
      for (const declaration of byName.values()) {
        const key = `plugin-${pluginId}-${declaration.name}`
        configs[key] = createSdkMcpServer({
          name: key,
          tools: declaration.tools.map((toolDeclaration) =>
            tool(
              toolDeclaration.name,
              toolDeclaration.description,
              zodShapeFromJsonSchema(toolDeclaration.inputSchema),
              async (input: unknown) => {
                const result = await this.invokePluginTool(pluginId, toolDeclaration.name, input)
                return result as { content: { type: 'text'; text: string }[] }
              }
            )
          )
        })
      }
    }
    return configs
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
  // Streams SDK messages through io.emit; resolves when the run ends and
  // aborts on io.signal (the dispatcher owns cancellation). Write/exec tools
  // route through the plugin consent dialog; read-only tools are
  // auto-allowed like agent runs.
  async runPrompt(
    client: ClientRecord,
    params: { prompt: string; model?: string; systemAppend?: string },
    worktree: Worktree,
    io: { emit: (chunk: unknown) => void; signal: AbortSignal }
  ): Promise<null> {
    await this.deps.broker.ensure(client, 'ai.prompt', truncate(params.prompt))
    const abort = new AbortController()
    if (io.signal.aborted) abort.abort()
    io.signal.addEventListener('abort', () => abort.abort())

    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const iterator = query({
      prompt: params.prompt,
      options: {
        cwd: worktree.path,
        abortController: abort,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: params.systemAppend || undefined
        },
        model: params.model || undefined,
        includePartialMessages: false,
        canUseTool: async (toolName, input) => {
          const allowed = await this.allowPromptTool(client, toolName, input)
          if (allowed) return { behavior: 'allow', updatedInput: input }
          return { behavior: 'deny', message: 'denied by the user' }
        }
      }
    })
    for await (const message of iterator) {
      io.emit([{ type: (message as { type?: string }).type ?? 'message', payload: message }])
    }
    return null
  }

  private async allowPromptTool(
    client: ClientRecord,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<boolean> {
    const readOnly = new Set(['Read', 'Grep', 'Glob', 'LS'])
    if (readOnly.has(toolName)) return true
    const detail = `${toolName}: ${truncate(JSON.stringify(input))}`
    try {
      await this.deps.broker.ensure(client, 'ai.prompt', detail)
      return true
    } catch (error) {
      if (error instanceof PermissionError) return false
      throw error
    }
  }
}

function truncate(text: string): string {
  if (text.length <= 200) return text
  return `${text.slice(0, 200)}…`
}
