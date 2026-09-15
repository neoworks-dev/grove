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
  // The answer being streamed, for harnesses that only report deltas.
  private streaming = new Map<string, string>()

  constructor(private options: HandoffBridgeOptions) {}

  /** Follow the event log. Returns the inverse, as every effect must. */
  watch(): () => void {
    return this.options.store.subscribe((event) => void this.handle(event))
  }

  /**
   * Follow what a session is saying.
   *
   * Harnesses differ on how an answer arrives: Claude and Codex close each
   * message with the blocks it was made of, pi only ever streams deltas. Both
   * are followed, and a closing message wins over what was streamed towards it.
   */
  private async handle(event: SessionEvent): Promise<void> {
    if (event.type === 'agent.message_start') {
      this.streaming.delete(event.sessionId)
      return
    }
    if (event.type === 'agent.message_delta') {
      const sofar = this.streaming.get(event.sessionId) ?? ''
      this.streaming.set(event.sessionId, sofar + event.text)
      return
    }
    if (event.type === 'agent.message_end') {
      this.streaming.delete(event.sessionId)
      this.remember(event.sessionId, textOf(event.content))
      return
    }
    if (event.type === 'session.status_idle') {
      this.settleStreamed(event.sessionId)
      await this.reportBack(event.sessionId)
    }
  }

  /** Whatever was streamed and never closed is still the session's last word. */
  private settleStreamed(sessionId: string): void {
    const streamed = this.streaming.get(sessionId)
    this.streaming.delete(sessionId)
    if (!streamed) return
    this.remember(sessionId, streamed.trim())
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
