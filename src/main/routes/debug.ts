// The debugger's IPC surface: thin calls into DebugService. State comes back
// as `event:debug-state` snapshots and `event:debug-output` lines.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import type { DebugBreakpointOptions } from '../../shared/debug'

/** Where a configuration is listed or started from, as the renderer names it. */
interface EditorContext {
  worktreeId: string
  activeFile?: string
  activeLine?: number
}

export const debugRoutes = {
  name: 'main/routes/debug',
  inject: ['workbench', 'debug'],

  apply(ctx: Context): void {
    /** The worktree's path and the editor's position, as the debugger takes them. */
    const contextOf = (
      editor: EditorContext
    ): { worktreePath: string; activeFile?: string; activeLine?: number } => ({
      worktreePath: ctx.workbench.findWorktree(editor.worktreeId).path,
      activeFile: editor.activeFile,
      activeLine: editor.activeLine
    })

    route(ctx, 'debug:snapshot', () => ctx.debug.snapshot())
    route(ctx, 'debug:output', () => ctx.debug.outputLines())
    route(ctx, 'debug:clearOutput', () => ctx.debug.clearOutput())

    route(ctx, 'debug:configurations', (_e, editor: EditorContext) =>
      ctx.debug.configurations(contextOf(editor))
    )
    route(ctx, 'debug:adapters', () => ctx.debug.adapters())
    route(ctx, 'debug:masonPackages', () => ctx.debug.masonPackages())
    route(ctx, 'debug:installAdapter', (_e, masonPackage: string) =>
      ctx.debug.installAdapter(masonPackage)
    )

    route(ctx, 'debug:start', (_e, editor: EditorContext, configuration: Record<string, unknown>) =>
      ctx.debug.start({ ...contextOf(editor), configuration })
    )
    route(ctx, 'debug:stop', (_e, sessionId?: string) => ctx.debug.stop(sessionId))
    route(ctx, 'debug:restart', (_e, sessionId?: string) => ctx.debug.restart(sessionId))
    route(ctx, 'debug:continue', (_e, sessionId?: string, threadId?: number) =>
      ctx.debug.continue(sessionId, threadId)
    )
    route(ctx, 'debug:pause', (_e, sessionId?: string, threadId?: number) =>
      ctx.debug.pause(sessionId, threadId)
    )
    route(ctx, 'debug:stepOver', (_e, sessionId?: string, threadId?: number) =>
      ctx.debug.stepOver(sessionId, threadId)
    )
    route(ctx, 'debug:stepInto', (_e, sessionId?: string, threadId?: number) =>
      ctx.debug.stepInto(sessionId, threadId)
    )
    route(ctx, 'debug:stepOut', (_e, sessionId?: string, threadId?: number) =>
      ctx.debug.stepOut(sessionId, threadId)
    )
    route(
      ctx,
      'debug:focus',
      (_e, sessionId: string, threadId: number | null, frameId: number | null) =>
        ctx.debug.focus(sessionId, threadId, frameId)
    )
    route(ctx, 'debug:setExceptionFilters', (_e, sessionId: string, filters: string[]) =>
      ctx.debug.setExceptionFilters(sessionId, filters)
    )

    route(
      ctx,
      'debug:stackTrace',
      (_e, sessionId: string, threadId: number, startFrame: number, levels: number) =>
        ctx.debug.stackTrace(sessionId, threadId, startFrame, levels)
    )
    route(ctx, 'debug:scopes', (_e, sessionId?: string, frameId?: number) =>
      ctx.debug.scopes(sessionId, frameId)
    )
    route(ctx, 'debug:variables', (_e, sessionId: string, variablesReference: number) =>
      ctx.debug.variables(sessionId, variablesReference)
    )
    route(
      ctx,
      'debug:evaluate',
      (
        _e,
        expression: string,
        context: 'repl' | 'watch' | 'hover',
        sessionId?: string,
        frameId?: number
      ) => ctx.debug.evaluate(expression, context, sessionId, frameId)
    )

    route(ctx, 'debug:toggleBreakpoint', (_e, path: string, line: number) =>
      ctx.debug.toggleBreakpoint(path, line)
    )
    route(
      ctx,
      'debug:setBreakpoint',
      (_e, path: string, line: number, options: DebugBreakpointOptions) =>
        ctx.debug.setBreakpoint(path, line, options)
    )
    route(ctx, 'debug:removeBreakpoint', (_e, id: string) => ctx.debug.removeBreakpoint(id))
    route(ctx, 'debug:removeAllBreakpoints', () => ctx.debug.removeAllBreakpoints())
    route(ctx, 'debug:setBreakpointEnabled', (_e, id: string, enabled: boolean) =>
      ctx.debug.setBreakpointEnabled(id, enabled)
    )
    route(ctx, 'debug:addWatch', (_e, expression: string) => ctx.debug.addWatch(expression))
    route(ctx, 'debug:removeWatch', (_e, expression: string) => ctx.debug.removeWatch(expression))
  }
}
