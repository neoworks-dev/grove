// Claude adapter — Anthropic Agent SDK. Uses `query()` which streams SDK
// messages (same shape as the CLI stream-json) and exposes `canUseTool`, the
// callback that pauses the run until the user approves or denies a tool. This
// is the only adapter with true interactive permissions.

// The SDK is ESM-only; the Electron main is CommonJS with externalized deps, so
// it must be loaded via dynamic import() (require() of an ESM package throws).
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConfig } from '../../shared/types'
import type { AdapterContext, AgentAdapter, RunHandle } from './types'
import { textLine } from './types'

const config: AgentConfig = {
  command: 'claude',
  interactive: true,
  // Permission modes map to the SDK's PermissionMode values.
  modes: [
    { label: 'manual review', value: 'default' },
    { label: 'plan', value: 'plan' },
    { label: 'accept edits', value: 'acceptEdits' },
    { label: 'auto', value: 'bypassPermissions' }
  ]
  // Models are free-text (no runtime model-list API); efforts unsupported by the SDK.
}

function filePathOf(input: Record<string, unknown>): string | null {
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  return null
}

function start(context: AdapterContext): RunHandle {
  const abort = new AbortController()
  const permissionMode = context.options.mode || 'default'
  let run: { interrupt: () => Promise<void> } | null = null

  void (async () => {
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      const iterator = query({
        prompt: context.options.prompt || '',
        options: {
          cwd: context.worktree.path,
          abortController: abort,
          // Resume the prior conversation when we have its session id.
          resume: context.resume || undefined,
          permissionMode: permissionMode as 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions',
          model: context.options.model || undefined,
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
            // AskUserQuestion is the model asking the user a question — not a
            // privileged action. Never gate it behind a permission prompt; it is
            // presented and answered through onUserDialog above.
            if (toolName === 'AskUserQuestion') {
              return { behavior: 'allow', updatedInput: input }
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
      for await (const message of iterator) {
        // Capture the session id (carried on system/init and result messages)
        // so the next turn resumes this conversation.
        const sessionId = (message as { session_id?: string }).session_id
        if (sessionId) context.setSession(sessionId)
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
    stop: async () => {
      abort.abort()
      try {
        await run?.interrupt()
      } catch {
        // already terminated
      }
    }
  }
}

export const claudeAdapter: AgentAdapter = { name: 'claude', config, start }
