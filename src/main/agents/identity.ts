// A session's identity among the other agents.
//
// Agents address each other by a short id stamped onto the session when it is
// created and never changed. Titles are for people: they are edited, reused and
// duplicated, and an address that moved when a user renamed a tab would strand
// every agent holding it. The id outlives all of that.

import { randomBytes } from 'node:crypto'

/** The session label the agent id lives on. */
export const AGENT_ID_LABEL = 'grove.agentId'

/**
 * A fresh agent id: six lowercase hex characters.
 *
 * Short enough for a model to copy out of a roster and back into `to`, and wide
 * enough (16 million) that two sessions in one worktree colliding is not a case
 * worth designing around.
 */
export function newAgentId(): string {
  return randomBytes(3).toString('hex')
}

/**
 * The id a session is addressed by.
 *
 * Sessions created before agent ids existed have no label; the head of their
 * session id stands in, which is just as stable and just as unique.
 */
export function agentIdOf(session: { id: string; labels: Record<string, string> }): string {
  return session.labels[AGENT_ID_LABEL] || session.id.slice(0, 8)
}
