// Adapter contract. Each agent SDK (claude, codex, opencode) implements an
// AgentAdapter that streams normalized "stream-json-like" lines (parsed by the
// renderer's agentStream) and, where supported, routes tool permission requests
// back to the user. Adapters never touch Electron/IPC directly — they only use
// the AdapterContext callbacks.

import type {
  AgentConfig,
  AgentDialogDecision,
  AgentDialogRequest,
  AgentLaunchOptions,
  AgentSlashCommand,
  AgentStatus,
  PermissionDecision,
  PermissionRequestEvent,
  Worktree,
  WorktreeChatMessage
} from '../../shared/types'

export interface AdapterContext {
  worktree: Worktree
  ports: number[]
  options: AgentLaunchOptions
  // Continuation token from a prior turn (SDK session/thread id). When set, the
  // adapter resumes that conversation instead of starting a fresh one.
  resume?: string
  // Emit one normalized stream event (a JSON string in the claude stream-json
  // shape: { type: 'assistant' | 'user' | ... , message: { content: [...] } }).
  emit: (line: string) => void
  setStatus: (status: AgentStatus, exitCode?: number | null) => void
  // Report the live session/thread id so the manager can resume it next turn.
  setSession: (token: string) => void
  // Ask the user to approve a tool call; resolves once they decide.
  requestPermission: (request: Omit<PermissionRequestEvent, 'id'>) => Promise<PermissionDecision>
  // Surface a blocking dialog (e.g. an agent question) and await the answer.
  requestDialog: (request: Omit<AgentDialogRequest, 'id'>) => Promise<AgentDialogDecision>
  // Plugin AI contributions (MCP servers proxied into plugin workers, skill
  // text appended to the system prompt). Absent when no plugins register any.
  pluginAi?: {
    mcpServers: () => Promise<Record<string, unknown>>
    systemAppend: () => string
  }
  // Full slash-command list discovered from the provider (replace semantics —
  // each call supersedes the previous list).
  setCommands?: (commands: AgentSlashCommand[]) => void
  // Try to lock file paths for this run before a mutating edit, so a second
  // agent in the same worktree can't clobber them. Returns { ok: false, heldBy }
  // when another agent holds one; the adapter then denies-with-message.
  tryAcquireLocks?: (paths: string[]) => { ok: boolean; heldBy?: string }
  // Release all of this run's file locks (called at each turn boundary).
  releaseLocks?: () => void
  // The worktree's shared chat channel (agent↔agent + agent↔user). Absent if
  // the adapter doesn't wire it. Exposed to the model as the grove-chat MCP
  // tools; `send`'s `from` is set by the manager (unspoofable).
  chat?: {
    send: (text: string, to?: string) => void
    history: (since?: number) => WorktreeChatMessage[]
  }
}

export interface RunHandle {
  stop: () => Promise<void>
  // Inject a user message into the live run. Returns false when the run can no
  // longer accept input (input stream closed / unsupported) — caller queues.
  send?: (text: string) => boolean
}

export interface AgentAdapter {
  name: string
  config: AgentConfig
  start: (context: AdapterContext) => RunHandle
}

// Helpers to build normalized stream lines so every adapter renders uniformly.

// The user's own prompt, surfaced in the transcript as a chat message.
export function userPromptLine(text: string): string {
  return JSON.stringify({ type: 'user_prompt', text })
}

export function textLine(id: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] }
  })
}

export function toolLine(id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: `${id}-msg`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }]
    }
  })
}

export function toolResultLine(toolUseId: string, content: string, isError = false): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]
    }
  })
}
