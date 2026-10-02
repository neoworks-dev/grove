// Agent sessions: the harnesses grove can run, and the sessions running on them.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { registerAgentProtocol } from '../agents/protocol'
import { cleanNotes } from '../agents/notes'
import { resolveLocations } from '../agents/locationAnchor'
import type {
  ClientEventBody,
  CodeLocation,
  CreateSessionOptions,
  PaneTypeInfo,
  SessionUpdate,
  TerminalCommand
} from '../../shared/agents'

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
    route(ctx, 'agents:saveNotes', (_e, sessionId: string, notes: unknown) =>
      ctx.agents.saveNotes(sessionId, cleanNotes(notes))
    )
    // Output of the commands a session is running, for a view that opens mid-run.
    route(ctx, 'agents:shellOutput', (_e, sessionId: string) => ctx.agents.shellOutput(sessionId))
    route(ctx, 'agents:interruptShell', (_e, sessionId: string, toolUseId: string) =>
      ctx.agents.interruptShell(sessionId, toolUseId)
    )
    route(ctx, 'agents:backgroundShell', (_e, sessionId: string) =>
      ctx.agents.backgroundShell(sessionId)
    )
    route(ctx, 'agents:recordTerminalCommand', (_e, sessionId: string, command: TerminalCommand) =>
      ctx.agents.recordTerminalCommand(sessionId, terminalCommandOf(command))
    )
    route(ctx, 'agents:writeShell', (_e, sessionId: string, toolUseId: string, data: string) =>
      ctx.agents.writeShell(sessionId, toolUseId, data)
    )
    route(
      ctx,
      'agents:resizeShell',
      (_e, sessionId: string, toolUseId: string, cols: number, rows: number) =>
        ctx.agents.resizeShell(sessionId, toolUseId, cols, rows)
    )
    // Where the places an agent pointed at are now, after the code moved under them.
    route(ctx, 'agents:resolveLocations', (_e, worktreeId: string, locations: CodeLocation[]) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      if (!Array.isArray(locations)) return []
      return resolveLocations(worktree.path, locations)
    })
    // The files a session edited, and each one without its edits, to diff against.
    route(ctx, 'agents:editedFiles', (_e, sessionId: string) => ctx.agents.editedFiles(sessionId))
    route(ctx, 'agents:editedFileBase', (_e, sessionId: string, path: string) =>
      ctx.agents.editedFileBase(sessionId, path)
    )
    route(ctx, 'agents:setPaneTypes', (_e, types: PaneTypeInfo[]) =>
      ctx.agents.setPaneTypes(types)
    )

    // ── Composer helpers ──────────────────────────────────────────
    route(ctx, 'agents:completeShell', (_e, sessionId: string, line: string) =>
      ctx.agents.completeShell(sessionId, line)
    )
    route(ctx, 'agents:shellName', () => ctx.agents.shellName())
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

/** A terminal command from the renderer, checked field by field before it goes on the log. */
function terminalCommandOf(value: TerminalCommand): TerminalCommand {
  if (typeof value?.command !== 'string' || value.command.trim().length === 0) {
    throw new Error('a terminal command needs a command line')
  }
  let output = ''
  if (typeof value.output === 'string') output = value.output
  let exitCode = 0
  if (Number.isInteger(value.exitCode)) exitCode = value.exitCode
  return { command: value.command, output, exitCode }
}
