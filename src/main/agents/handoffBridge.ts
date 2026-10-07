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
import { lastAgentMessage } from './acpLog'
import type { AgentRoster } from './roster'
import { signatureOfSession } from './roster'
import type { SessionStore, StoredSession } from './store'
import { isSubagentSession } from './subagents'

/** The label `spawn_agent` writes onto a child session. */
export const PARENT_LABEL = 'grove.parent'

/**
 * Set on a session that should not outlive the work it was started for.
 *
 * A one-shot helper — "read this file and tell me what it says" — leaves a tab
 * nobody will open again, so the agent that started it can say up front that it
 * is a throwaway.
 */
export const DISPOSE_LABEL = 'grove.dispose'

export interface HandoffBridgeOptions {
  store: SessionStore
  roster: AgentRoster
}

export class AgentHandoffBridge {
  // Sessions this bridge removed itself, whose parent has already been told.
  private cleanedUp = new Set<string>()
  // The last message each session reported, so a turn that says nothing new —
  // a command, a second idle — does not send the previous answer again.
  private reported = new Map<string, number>()

  constructor(private options: HandoffBridgeOptions) {}

  /** Follow the event log. Returns the inverse, as every effect must. */
  watch(): () => void {
    return this.options.store.subscribe((event) => void this.handle(event))
  }

  /** A turn ended: whatever the agent said last in it is its answer. */
  private async handle(event: SessionEvent): Promise<void> {
    if (event.type !== 'session.status_idle') return
    const last = lastAgentMessage(this.options.store.peekEvents(event.sessionId))
    if (!last) return
    const previous = this.reported.get(event.sessionId)
    if (previous !== undefined && previous >= last.seq) return
    this.reported.set(event.sessionId, last.seq)
    await this.reportBack(event.sessionId, last.text.trim())
  }

  /**
   * A child's turn ended: hand its answer to the agent that started it.
   *
   * Only a message said since the last prompt counts, so a turn that produces
   * nothing new — an interrupted run, a turn spent entirely in tools — reports
   * nothing rather than sending the previous answer a second time.
   */
  private async reportBack(sessionId: string, text: string): Promise<void> {
    if (text.length === 0) return

    const session = await this.options.store.get(sessionId)
    const parentSessionId = session?.labels[PARENT_LABEL]
    if (!session || !parentSessionId) return
    if (parentSessionId === sessionId) return
    // An agent the harness ran itself already reports back: its answer is the
    // result of the tool call that started it, which the parent is waiting on.
    if (isSubagentSession(session)) return

    const parent = await this.options.store.get(parentSessionId)
    if (!parent) return

    const from = await this.options.roster.signatureOf(sessionId)
    await this.options.roster.deliver(parentSessionId, from, text, sessionId).catch(() => {})
    // Disposal follows the report, never precedes it: an agent removed before
    // its answer reached the parent would have worked for nothing.
    if (session.labels[DISPOSE_LABEL] === 'whenDone') {
      this.cleanedUp.add(sessionId)
      await this.options.roster.dispose(sessionId).catch(() => {})
    }
  }

  /**
   * A session was removed: tell the agents on either side of it.
   *
   * An orchestrator otherwise keeps addressing a child that no longer exists
   * and waits for a hand-off that will never come, and a child keeps working
   * for a parent that will never read the answer. A session the bridge cleared
   * away itself is left alone — its parent already has the answer, and the
   * removal is the thing it asked for.
   */
  async reportClosed(session: StoredSession): Promise<void> {
    if (this.cleanedUp.delete(session.id)) return

    const from = signatureOfSession(session)
    await this.tellParent(session, from)
    await this.tellChildren(session, from)
  }

  /** The agent that started it is waiting for a report that is not coming. */
  private async tellParent(session: StoredSession, from: string): Promise<void> {
    const parentSessionId = session.labels[PARENT_LABEL]
    if (!parentSessionId || parentSessionId === session.id) return
    const parent = await this.options.store.get(parentSessionId)
    if (!parent) return
    await this.deliver(parentSessionId, from, CLOSED_NOTICE)
  }

  /** Anything it spawned is still working for an agent that is now gone. */
  private async tellChildren(session: StoredSession, from: string): Promise<void> {
    const sessions = await this.options.store.list()
    const children = sessions.filter(
      (entry) =>
        entry.id !== session.id &&
        entry.labels[PARENT_LABEL] === session.id &&
        !isSubagentSession(entry)
    )
    for (const child of children) await this.deliver(child.id, from, REQUESTER_CLOSED_NOTICE)
  }

  private async deliver(sessionId: string, from: string, text: string): Promise<void> {
    await this.options.roster.deliver(sessionId, from, text).catch(() => {})
  }
}

/** What a parent is told when one of its agents is closed out from under it. */
const CLOSED_NOTICE =
  'This agent was closed before reporting back. Its work has stopped and its id is no longer reachable — do not send to it again.'

/** What a spawned agent is told when the agent that briefed it is closed. */
const REQUESTER_CLOSED_NOTICE =
  'The agent that gave you this task was closed and is no longer reachable. Stop when the current step is done, and report to the user here instead.'
