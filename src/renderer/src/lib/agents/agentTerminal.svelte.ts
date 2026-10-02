// Bringing a command up in the agent terminal: from its card in the
// transcript, or from the background list under the composer, when it waits
// for someone to type or just to watch it.

import { layout } from '../layout.svelte'
import { panels } from '../panels.svelte'

/** A command someone asked to see; the agent terminal picks it up and shows its tab. */
export interface CommandRequest {
  sessionId: string
  commandId: string
  /** Distinguishes asking twice for the same command. */
  at: number
}

class AgentTerminalRequests {
  requested = $state<CommandRequest | null>(null)

  /** Reveals the agent terminal; with a command, on that command, with the keyboard in it. */
  show(sessionId?: string, commandId?: string): void {
    panels.reveal('agent-shell')
    layout.ensurePane('panel')
    if (!sessionId || !commandId) return
    this.requested = { sessionId, commandId, at: Date.now() }
  }
}

export const agentTerminal = new AgentTerminalRequests()
