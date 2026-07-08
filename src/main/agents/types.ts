// Adapter contract. Each agent SDK (claude, codex, opencode) implements an
// AgentAdapter that streams normalized "stream-json-like" lines (parsed by the
// renderer's agentStream) and, where supported, routes tool permission requests
// back to the user. Adapters never touch Electron/IPC directly — they only use
// the AdapterContext callbacks.

import type {
  AgentConfig,
  AgentLaunchOptions,
  AgentStatus,
  PermissionDecision,
  PermissionRequestEvent,
  Worktree
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
  requestPermission: (
    request: Omit<PermissionRequestEvent, 'id'>
  ) => Promise<PermissionDecision>
}

export interface RunHandle {
  stop: () => Promise<void>
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

export function toolLine(
  id: string,
  name: string,
  input: Record<string, unknown>
): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id: `${id}-msg`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
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
