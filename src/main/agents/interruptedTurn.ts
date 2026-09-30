// A turn the log says is still running, when nothing is running it any more.
//
// Runs live in memory. When Grove quits mid-turn — or crashes, or restarts on
// an update — the log is left ending on `session.status_running`, perhaps with
// a tool call parked on an approval nobody can answer now. Read back, that is a
// session that looks busy forever: a spinner, a Stop that has nothing to stop,
// and a prompt whose answer goes nowhere.

import type { SessionEvent } from '../../shared/agents'

/** A tool call that was made and never got a result. */
export interface OpenToolCall {
  toolUseId: string
  name: string
}

/**
 * The tool calls a turn left open, when the log ends inside a turn; null when
 * the last turn ended. A call the user denied counts as settled: its card
 * already says so, and no result is owed to it.
 */
export function interruptedTurn(events: readonly SessionEvent[]): OpenToolCall[] | null {
  let running = false
  const open = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'session.status_running') running = true
    // A call an ended turn never resolved is that turn's business, not this one's.
    if (event.type === 'session.status_idle' || event.type === 'session.status_terminated') {
      running = false
      open.clear()
    }
    if (event.type === 'agent.tool_use') open.set(event.toolUseId, event.name)
    if (event.type === 'agent.tool_result') open.delete(event.toolUseId)
    if (event.type === 'user.tool_confirmation' && event.result === 'deny') {
      open.delete(event.toolUseId)
    }
  }
  if (!running) return null
  return [...open].map(([toolUseId, name]) => ({ toolUseId, name }))
}
