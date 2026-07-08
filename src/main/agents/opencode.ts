// OpenCode adapter — @opencode-ai/sdk. Starts an OpenCode server, opens a
// session rooted at the worktree, and runs a blocking prompt. Tool permission
// requests arrive on the server's event bus (subscribed concurrently) and are
// routed to the user's approval dialog, then answered via the permissions
// endpoint. The final assistant message parts are emitted when the prompt
// resolves.

// ESM-only SDK — loaded via dynamic import() from the CommonJS main process.
import type { createOpencode as CreateOpencode } from '@opencode-ai/sdk'
import type { AgentConfig } from '../../shared/types'
import type { AdapterContext, AgentAdapter, RunHandle } from './types'
import { textLine, toolLine, toolResultLine } from './types'

const config: AgentConfig = {
  command: 'opencode',
  interactive: true
  // Models are provider-scoped ({providerID, modelID}); left as server default.
}

// Emit the final parts of an assistant message.
function emitParts(context: AdapterContext, parts: unknown[]): void {
  for (const raw of parts) {
    const part = raw as { type?: string; id?: string; text?: string; callID?: string; tool?: string; state?: Record<string, unknown> }
    if (part.type === 'text' && part.text) {
      context.emit(textLine(part.id || 'text', part.text))
    } else if (part.type === 'tool') {
      const state = part.state || {}
      const input = (state.input as Record<string, unknown>) || {}
      context.emit(toolLine(part.callID || part.id || 'tool', part.tool || 'tool', input))
      if (typeof state.output === 'string') {
        context.emit(toolResultLine(part.callID || part.id || 'tool', state.output, state.status === 'error'))
      }
    }
  }
}

function start(context: AdapterContext): RunHandle {
  const directory = context.worktree.path
  const subscription = new AbortController()
  let closed = false
  let server: { close: () => void } | null = null
  let sessionId = ''

  async function respondToPermissions(
    client: Awaited<ReturnType<typeof CreateOpencode>>['client']
  ): Promise<void> {
    const events = await client.event.subscribe({ signal: subscription.signal })
    for await (const event of events.stream) {
      if (event.type !== 'permission.updated') continue
      const permission = event.properties
      if (permission.sessionID !== sessionId) continue
      const decision = await context.requestPermission({
        worktreeId: context.worktree.id,
        agent: 'opencode',
        toolName: permission.type || 'tool',
        title: permission.title,
        path: null,
        input: (permission.metadata as Record<string, unknown>) || {}
      })
      const response =
        decision.behavior === 'allow' ? (decision.remember ? 'always' : 'once') : 'reject'
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permission.id },
        query: { directory },
        body: { response }
      })
    }
  }

  void (async () => {
    try {
      const { createOpencode } = await import('@opencode-ai/sdk')
      const { client, server: srv } = await createOpencode()
      server = srv

      const created = await client.session.create({ query: { directory } })
      sessionId = created.data?.id || ''
      if (!sessionId) throw new Error('failed to create opencode session')

      // Subscribe for permission prompts in the background.
      void respondToPermissions(client).catch(() => {})

      const result = await client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: { parts: [{ type: 'text', text: context.options.prompt || '' }] }
      })

      emitParts(context, result.data?.parts || [])
      context.setStatus(closed ? 'stopped' : 'exited', 0)
    } catch (error) {
      if (closed) {
        context.setStatus('stopped')
      } else {
        context.emit(textLine('error', `[error] ${(error as Error).message}`))
        context.setStatus('error', 1)
      }
    } finally {
      subscription.abort()
      server?.close()
    }
  })()

  return {
    stop: async () => {
      closed = true
      subscription.abort()
      server?.close()
    }
  }
}

export const opencodeAdapter: AgentAdapter = { name: 'opencode', config, start }
