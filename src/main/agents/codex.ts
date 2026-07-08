// Codex adapter — OpenAI Codex SDK. Runs a thread with `runStreamed` and maps
// its ThreadEvents onto the normalized stream shape. Codex governs tool access
// through `approvalPolicy` + `sandboxMode` (no interactive per-tool callback),
// so it does not surface the live permission dialog.

// ESM-only SDK — loaded via dynamic import() from the CommonJS main process.
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk'
import type { AgentConfig } from '../../shared/types'
import type { AdapterContext, AgentAdapter, RunHandle } from './types'
import { textLine, toolLine, toolResultLine } from './types'

const config: AgentConfig = {
  command: 'codex',
  modes: [
    { label: 'manual review', value: 'on-request' },
    { label: 'on failure', value: 'on-failure' },
    { label: 'untrusted', value: 'untrusted' },
    { label: 'auto', value: 'never' }
  ],
  efforts: [
    { label: 'minimal', value: 'minimal' },
    { label: 'low', value: 'low' },
    { label: 'medium', value: 'medium' },
    { label: 'high', value: 'high' },
    { label: 'xhigh', value: 'xhigh' }
  ]
}

// Map a completed thread item onto normalized stream lines.
function emitItem(context: AdapterContext, item: ThreadItem): void {
  if (item.type === 'agent_message') {
    context.emit(textLine(item.id, item.text))
  } else if (item.type === 'reasoning') {
    context.emit(textLine(item.id, item.text))
  } else if (item.type === 'command_execution') {
    context.emit(toolLine(item.id, 'Bash', { command: item.command }))
    if (item.aggregated_output) {
      context.emit(toolResultLine(item.id, item.aggregated_output, item.status === 'failed'))
    }
  } else if (item.type === 'file_change') {
    for (const change of item.changes) {
      context.emit(toolLine(`${item.id}:${change.path}`, 'Edit', { file_path: change.path, kind: change.kind }))
    }
  } else if (item.type === 'mcp_tool_call') {
    context.emit(toolLine(item.id, `${item.server}:${item.tool}`, (item.arguments as Record<string, unknown>) || {}))
  } else if (item.type === 'error') {
    context.emit(textLine(item.id, `[error] ${item.message}`))
  }
}

function handleEvent(context: AdapterContext, event: ThreadEvent): void {
  // Render items once, on completion, to avoid duplicate partial updates.
  if (event.type === 'item.completed') {
    emitItem(context, event.item)
  } else if (event.type === 'error') {
    context.emit(textLine('error', `[error] ${event.message}`))
  }
}

function start(context: AdapterContext): RunHandle {
  let stopped = false
  void (async () => {
    try {
      const { Codex } = await import('@openai/codex-sdk')
      const codex = new Codex()
      const thread = codex.startThread({
        workingDirectory: context.worktree.path,
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        approvalPolicy:
          (context.options.mode as 'on-request' | 'on-failure' | 'untrusted' | 'never') ||
          'on-request',
        model: context.options.model || undefined,
        modelReasoningEffort:
          (context.options.effort as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh') || undefined
      })
      const { events } = await thread.runStreamed(context.options.prompt || '')
      for await (const event of events) {
        if (stopped) break
        handleEvent(context, event)
      }
      context.setStatus(stopped ? 'stopped' : 'exited', 0)
    } catch (error) {
      if (stopped) {
        context.setStatus('stopped')
        return
      }
      context.emit(textLine('error', `[error] ${(error as Error).message}`))
      context.setStatus('error', 1)
    }
  })()

  return {
    stop: async () => {
      stopped = true
    }
  }
}

export const codexAdapter: AgentAdapter = { name: 'codex', config, start }
