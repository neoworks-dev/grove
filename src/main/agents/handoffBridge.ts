// Spawned agents report back on their own.
//
// An agent started with `spawn_agent` is labelled with the session that started
// it. When such a session finishes a turn, its closing words are delivered to
// that parent — the hand-off the orchestrating agent is waiting for, without it
// having to poll `read_messages` or the child having to remember to answer.
//
// Only the last assistant message of the turn travels: everything before it is
// the child's working-out, which the parent can read in its own pane if it cares.

import type { SessionEvent } from '../../shared/agents'
import type { AgentRoster } from './roster'
import type { SessionStore } from './store'

/** The label `spawn_agent` writes onto a child session. */
export const PARENT_LABEL = 'grove.parent'

export interface HandoffBridgeOptions {
  store: SessionStore
  roster: AgentRoster
}

export class AgentHandoffBridge {
  // The last thing each session said, kept until its turn ends.
  private lastMessage = new Map<string, string>()

  constructor(private options: HandoffBridgeOptions) {}

  /** Follow the event log. Returns the inverse, as every effect must. */
  watch(): () => void {
    return this.options.store.subscribe((event) => void this.handle(event))
  }

  private async handle(event: SessionEvent): Promise<void> {
    if (event.type === 'agent.message_end') {
      this.remember(event.sessionId, textOf(event.content))
      return
    }
    if (event.type === 'session.status_idle') await this.reportBack(event.sessionId)
  }

  private remember(sessionId: string, text: string): void {
    if (text.length === 0) return
    this.lastMessage.set(sessionId, text)
  }

  /**
   * A child's turn ended: hand its answer to the agent that started it.
   *
   * The text is cleared either way, so a turn that produces nothing new — an
   * interrupted run, a turn spent entirely in tools — reports nothing rather
   * than sending the previous answer a second time.
   */
  private async reportBack(sessionId: string): Promise<void> {
    const text = this.lastMessage.get(sessionId)
    this.lastMessage.delete(sessionId)
    if (!text) return

    const session = await this.options.store.get(sessionId)
    const parentSessionId = session?.labels[PARENT_LABEL]
    if (!session || !parentSessionId) return
    if (parentSessionId === sessionId) return

    const parent = await this.options.store.get(parentSessionId)
    if (!parent) return

    const from = await this.options.roster.signatureOf(sessionId)
    await this.options.roster.deliver(parentSessionId, from, text).catch(() => {})
  }
}

/** The text of an assistant message, with non-text blocks left out. */
function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}
