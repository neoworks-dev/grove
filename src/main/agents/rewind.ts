// Where a conversation taken back to an earlier event continues from.
//
// The log is append-only, so a rewind is recorded rather than done: a
// `session.branched` event names the event the conversation now continues from,
// and the renderer's fold (`lib/agents/transcript.ts`) shows the path from there
// back to the start. The harness has to be taken back to the same place, and it
// knows its conversation only by the agent messages in it, so what this finds is
// the last agent message on that path.
//
// The path is the fold's: every event hangs off the one before it, except that
// `session.branched` moves the head to its `fromSeq`, a cleared conversation
// (`session_changed`) moves it back to the start, and the events that are not
// steps in the conversation (the branch request, notes, the plan) hang off
// nothing. The two must agree, or the agent would carry on from somewhere other
// than what the user sees.

import type { SessionEvent } from '../../shared/agents'

/** The start of the conversation, which every path ends at. */
const ROOT = 0

/** Where the harness's conversation has to be cut for a rewind. */
export type RewindPoint =
  /** Nothing the agent said is kept: the conversation starts over. */
  | { kind: 'start' }
  /** Keep the conversation up to and including this agent message, by its ACP `messageId`. */
  | { kind: 'message'; messageId: string }
  /** The agent said something on the way, but the harness gave it no id to cut at. */
  | { kind: 'unidentified' }

/**
 * Where to cut the harness's conversation so that it continues from the event at
 * `fromSeq`, or null when the log has no such event.
 */
export function rewindPoint(events: readonly SessionEvent[], fromSeq: number): RewindPoint | null {
  const { parentOf, bySeq } = conversationTree(events)
  if (fromSeq !== ROOT && !parentOf.has(fromSeq)) return null

  let current = fromSeq
  const seen = new Set<number>()
  while (current !== ROOT && !seen.has(current)) {
    seen.add(current)
    const point = agentMessagePoint(bySeq.get(current))
    if (point) return point
    current = parentOf.get(current) ?? ROOT
  }
  return { kind: 'start' }
}

/** Each conversation step's parent, as the renderer's fold links them, and the steps by seq. */
function conversationTree(events: readonly SessionEvent[]): {
  parentOf: Map<number, number>
  bySeq: Map<number, SessionEvent>
} {
  const parentOf = new Map<number, number>()
  const bySeq = new Map<number, SessionEvent>()
  let head = ROOT
  for (const event of events) {
    if (event.type === 'session.branched') {
      head = event.fromSeq
      continue
    }
    if (event.type === 'session_changed') {
      head = ROOT
      continue
    }
    if (!isConversationStep(event)) continue
    parentOf.set(event.seq, head)
    bySeq.set(event.seq, event)
    head = event.seq
  }
  return { parentOf, bySeq }
}

/** Whether the fold makes the event a step of the conversation, rather than something beside it. */
function isConversationStep(event: SessionEvent): boolean {
  if (event.type === 'user.branch') return false
  if (event.type === 'session.notes') return false
  if (event.type === 'update' && event.update.sessionUpdate === 'plan') return false
  return true
}

/** The cut an event marks, when it is part of something the agent said. */
function agentMessagePoint(event: SessionEvent | undefined): RewindPoint | null {
  if (!event || event.type !== 'update') return null
  const update = event.update
  if (
    update.sessionUpdate !== 'agent_message_chunk' &&
    update.sessionUpdate !== 'agent_thought_chunk'
  ) {
    return null
  }
  if (!update.messageId) return { kind: 'unidentified' }
  return { kind: 'message', messageId: update.messageId }
}
