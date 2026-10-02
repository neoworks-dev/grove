// What the commands agents run are printing, as they print it.
//
// Main streams it off the event log (the call's result records the output once
// the command is done), so a view that opens mid-run asks for what it missed.
// Output of a finished command is kept for the session's terminal view, which
// shows it with the escapes and carriage returns a result does not keep.

import type { ShellOutputUpdate } from './types'

export interface LiveCommandOutput {
  text: string
  running: boolean
  /** Nothing waits on it any more: its call returned, or it was sent to the background. */
  background: boolean
}

// Only the end of a very long run is kept, as in main.
const MAX_KEPT_CHARACTERS = 512 * 1024

class ShellOutputs {
  // By session, then by tool call.
  bySession = $state<Record<string, Record<string, LiveCommandOutput>>>({})

  /** What the call has printed, or undefined when nothing was streamed for it. */
  of(sessionId: string, toolUseId: string): LiveCommandOutput | undefined {
    return this.bySession[sessionId]?.[toolUseId]
  }

  /** Every streamed command in the session, by tool call. */
  forSession(sessionId: string): Record<string, LiveCommandOutput> {
    return this.bySession[sessionId] ?? {}
  }

  /** Folds in an update main pushed. */
  apply(update: ShellOutputUpdate): void {
    const session = this.sessionEntry(update.sessionId)
    const existing = session[update.toolUseId]
    if (!existing) {
      session[update.toolUseId] = {
        text: update.text,
        running: update.running,
        background: update.background
      }
      return
    }
    existing.text = keepTail(existing.text + update.text)
    existing.running = update.running
    existing.background = update.background
  }

  /** Catches up on a session's running commands, for a view opening mid-run. */
  async load(sessionId: string): Promise<void> {
    const snapshot = await window.workbench.agents.shellOutput(sessionId).catch(() => [])
    const session = this.sessionEntry(sessionId)
    for (const command of snapshot) {
      session[command.toolUseId] = {
        text: command.text,
        running: command.running,
        background: command.background
      }
    }
  }

  /** Ctrl+C for a command the session is running. */
  interrupt(sessionId: string, toolUseId: string): void {
    void window.workbench.agents.interruptShell(sessionId, toolUseId)
  }

  /** Ctrl+B: the agent stops waiting on its running commands, which keep going. */
  background(sessionId: string): void {
    void window.workbench.agents.backgroundShell(sessionId)
  }

  private sessionEntry(sessionId: string): Record<string, LiveCommandOutput> {
    if (!this.bySession[sessionId]) this.bySession[sessionId] = {}
    return this.bySession[sessionId]
  }
}

function keepTail(text: string): string {
  if (text.length <= MAX_KEPT_CHARACTERS) return text
  return text.slice(text.length - MAX_KEPT_CHARACTERS)
}

export const shellOutputs = new ShellOutputs()
