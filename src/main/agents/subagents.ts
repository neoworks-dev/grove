// The agents a harness runs inside its own tool calls.
//
// A runtime that delegates — Claude's Task calls, whatever a third-party harness
// spawns — produces a second conversation while the first one is still being
// written. grove already has a shape for that: a session an agent spawned, shown
// inside the family of the one that spawned it. This maps the one onto the
// other, so a harness's own agents are sessions like any other and nothing
// downstream — the tabs, the transcript fold, the unread badges — needs to learn
// what a subagent is.
//
// A lane is the tool call that started the agent. Its first event creates the
// session; its tool result ends it.

import type { ServerEventBody } from '../../shared/agents'
import type { SubagentIdentity } from './harness'

/** The label naming the tool call a subagent session was started by. */
export const SUBAGENT_LABEL = 'grove.subagentOf'

/**
 * Was this session an agent a harness ran inside a tool call?
 *
 * Such a session is a record rather than a conversation: nothing can be said to
 * it, it answers only the call that started it, and it is over when that call
 * returns. Everything that treats sessions as agents you can reach — the roster,
 * the hand-off back to whoever asked — has to leave it out.
 */
export function isSubagentSession(session: { labels: Record<string, string> }): boolean {
  return Boolean(session.labels[SUBAGENT_LABEL])
}

export interface SubagentSessionsOptions {
  /**
   * Open a session for an agent, under the session that started it. Returns the
   * new session's id.
   */
  open(parentSessionId: string, agent: SubagentIdentity): Promise<string>
  /** Put an event on a session's log, exactly as a harness's own events go on it. */
  absorb(sessionId: string, body: ServerEventBody): Promise<void>
}

/**
 * Which session each of a run's subagents writes to.
 *
 * Sessions are opened on demand, because a harness reports an agent's first
 * message rather than announcing it, and opening one is asynchronous while
 * events arrive in a burst — so the promise is what is remembered, not the id.
 */
export class SubagentSessions {
  private lanes = new Map<string, Promise<string>>()

  constructor(private options: SubagentSessionsOptions) {}

  /** Put an event on the session belonging to one agent, opening it if needed. */
  async absorb(
    parentSessionId: string,
    agent: SubagentIdentity,
    body: ServerEventBody
  ): Promise<void> {
    const sessionId = await this.sessionFor(parentSessionId, agent)
    await this.options.absorb(sessionId, body)
  }

  /**
   * End the agent a tool call was running, if it was running one.
   *
   * The result of the call is the agent's last word: the runtime has nothing
   * more to say in that lane, and a session left running would sit in the tabs
   * claiming to work forever.
   */
  async close(parentSessionId: string, toolUseId: string): Promise<void> {
    const key = laneKey(parentSessionId, toolUseId)
    const pending = this.lanes.get(key)
    if (!pending) return
    this.lanes.delete(key)

    const sessionId = await pending
    await this.options.absorb(sessionId, {
      type: 'session.status_terminated',
      reason: 'finished'
    })
  }

  private sessionFor(parentSessionId: string, agent: SubagentIdentity): Promise<string> {
    const key = laneKey(parentSessionId, agent.toolUseId)
    const known = this.lanes.get(key)
    if (known) return known

    const opening = this.options.open(parentSessionId, agent)
    this.lanes.set(key, opening)
    return opening
  }
}

function laneKey(parentSessionId: string, toolUseId: string): string {
  return `${parentSessionId}:${toolUseId}`
}
