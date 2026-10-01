// Draws the debugger's state into every editor: breakpoint signs in the gutter
// and the line execution stopped on. Every pane is its own nvim, so each one
// gets the whole state — on every change, and once more when it announces
// itself (`grove_debug_ready`, sent by debug.lua as it loads). The drawing
// itself is debug.lua's `sync`.

import type { DebugBreakpoint, DebugLocation } from '../../shared/debug'

/** The slice of NeovimManager the sync needs. */
export interface NvimSessions {
  sessionIds(): string[]
  request(id: string, method: string, args: unknown[]): Promise<unknown>
}

/** One breakpoint as debug.lua draws it. */
export interface EditorBreakpoint {
  id: string
  path: string
  line: number
  enabled: boolean
  verified: boolean
  /** Picks the sign: a plain breakpoint, a conditional one or a logpoint. */
  kind: 'breakpoint' | 'conditional' | 'log'
}

export interface EditorDebugState {
  breakpoints: EditorBreakpoint[]
  stopped: DebugLocation | null
  /** Whether a session runs, so a breakpoint it did not accept shows hollow. */
  sessionActive: boolean
}

const SYNC_LUA = `
local state = ...
if _G.grove_debug then
  _G.grove_debug.sync(state)
end
`

export class DebugEditorSync {
  private state: EditorDebugState = { breakpoints: [], stopped: null, sessionActive: false }
  private serialized = ''

  constructor(private nvim: NvimSessions) {}

  /** Adopts a new state and pushes it to every editor, unless nothing changed. */
  update(
    breakpoints: DebugBreakpoint[],
    stopped: DebugLocation | null,
    sessionActive: boolean
  ): void {
    const state: EditorDebugState = {
      breakpoints: breakpoints.map((breakpoint) => editorBreakpointOf(breakpoint)),
      stopped,
      sessionActive
    }
    const serialized = JSON.stringify(state)
    if (serialized === this.serialized) {
      return
    }
    this.state = state
    this.serialized = serialized
    for (const sessionId of this.nvim.sessionIds()) {
      this.pushTo(sessionId)
    }
  }

  /** Sends the current state to one editor, as it starts. */
  pushTo(sessionId: string): void {
    this.nvim.request(sessionId, 'nvim_exec_lua', [SYNC_LUA, [this.state]]).catch((error) => {
      console.warn(`[debug] could not draw breakpoints in ${sessionId}:`, error)
    })
  }
}

export function editorBreakpointOf(breakpoint: DebugBreakpoint): EditorBreakpoint {
  let kind: EditorBreakpoint['kind'] = 'breakpoint'
  if (breakpoint.logMessage) {
    kind = 'log'
  } else if (breakpoint.condition || breakpoint.hitCondition) {
    kind = 'conditional'
  }
  return {
    id: breakpoint.id,
    path: breakpoint.path,
    line: breakpoint.line,
    enabled: breakpoint.enabled,
    verified: breakpoint.verified,
    kind
  }
}
