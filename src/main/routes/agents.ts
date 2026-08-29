// Agent sessions: the harnesses grove can run, and the sessions running on them.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { registerAgentProtocol } from '../agents/protocol'
import type { ClientEventBody, CreateSessionOptions, SessionUpdate } from '../../shared/agents'

export const agentRoutes = {
  name: 'main/routes/agents',
  inject: ['agents', 'workbench'],

  apply(ctx: Context): void {
    // Attachments are fetched by URL rather than over IPC, so an <img> in the
    // transcript can point straight at one.
    ctx.effect(() => registerAgentProtocol(ctx.agents), 'protocol:grove-agent')

    // Every session event is pushed to the renderer; a pane that is not looking
    // at that session drops it. Cheaper than one subscription per pane, and the
    // seq on each event makes a late listener idempotent.
    ctx.effect(() => ctx.agents.watch(), 'agents:publish')

    // ── Harnesses ─────────────────────────────────────────────────
    route(ctx, 'agents:harnesses', () => ctx.agents.harnesses())
    route(ctx, 'agents:catalog', (_e, harnessId: string) => ctx.agents.catalog(harnessId))

    // ── Sessions ──────────────────────────────────────────────────
    route(ctx, 'agents:listSessions', () => ctx.agents.listSessions())
    route(ctx, 'agents:createSession', (_e, options: CreateSessionOptions) =>
      ctx.agents.createSession(options)
    )
    route(ctx, 'agents:getSession', (_e, sessionId: string) => ctx.agents.getSession(sessionId))
    route(ctx, 'agents:updateSession', (_e, sessionId: string, changes: SessionUpdate) =>
      ctx.agents.updateSession(sessionId, changes)
    )
    route(ctx, 'agents:deleteSession', (_e, sessionId: string) =>
      ctx.agents.deleteSession(sessionId)
    )

    // ── Conversation ──────────────────────────────────────────────
    route(ctx, 'agents:listEvents', (_e, sessionId: string, after: number) =>
      ctx.agents.listEvents(sessionId, after)
    )
    route(ctx, 'agents:sendEvents', (_e, sessionId: string, events: ClientEventBody[]) =>
      ctx.agents.send(sessionId, events)
    )

    // ── Composer helpers ──────────────────────────────────────────
    route(ctx, 'agents:searchFiles', (_e, sessionId: string, query: string, limit?: number) =>
      ctx.agents.searchFiles(sessionId, query, limit)
    )
    route(
      ctx,
      'agents:uploadBlob',
      (_e, sessionId: string, bytes: Uint8Array, mediaType: string, filename?: string) =>
        ctx.agents.putBlob(sessionId, bytes, mediaType, filename)
    )
  }
}
