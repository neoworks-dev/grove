// Bringing a command up in the agent terminal — from its card in the
// transcript, or from the background list under the composer, when it waits
// for someone to type or just to watch it — and the shell each session's agent
// terminal keeps for the user.

import { layout } from '../layout.svelte'

/** A command someone asked to see; the agent terminal picks it up and shows its tab. */
export interface CommandRequest {
  sessionId: string
  commandId: string
  /** Distinguishes asking twice for the same command. */
  at: number
}

class AgentTerminalRequests {
  requested = $state<CommandRequest | null>(null)
  /**
   * The shell each session's agent terminal runs, by session id, as the
   * terminal daemon knows it. The daemon keeps it running while no view shows
   * it, so switching sessions and back finds the same shell.
   */
  shells = $state<Record<string, string>>({})

  /** Reveals the agent terminal; with a command, on that command, with the keyboard in it. */
  show(sessionId?: string, commandId?: string): void {
    layout.ensurePane('agent-shell')
    if (!sessionId || !commandId) return
    this.requested = { sessionId, commandId, at: Date.now() }
  }
}

export const agentTerminal = new AgentTerminalRequests()
