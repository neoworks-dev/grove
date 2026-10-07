// When an agent's message waits for the user instead of waking a session.
//
// Waking a session that has slept past its prompt cache's lifetime sends its
// whole context to the model again, uncached: for a conversation hundreds of
// thousands of tokens long, that is real money spent on a message the user may
// not have wanted delivered at all. An hour is past every cache lifetime the
// harnesses use (five minutes, or an hour at most), so a session idle longer
// than that is asked about rather than woken.
//
// What is held and what was decided both live on the session's log, so a held
// message survives a restart and the pending ones are always a fold over it.

import type { HeldMessage, ModelPricing, SessionEvent, SessionMeta } from '../../shared/agents'

export const WAKE_THRESHOLD_MS = 60 * 60 * 1000

/**
 * When the session's last turn ended, or null when it has never finished one
 * or is in one now. That moment, not the last write to the log, is when its
 * prompt cache started to go cold.
 */
export function idleSinceOf(events: readonly SessionEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'session.status_running') return null
    if (event.type === 'session.status_idle') return event.createdAt
  }
  return null
}

/**
 * Since when the session has slept too long to wake for free, or null when a
 * message may go straight in: it is working, has never run (there is no
 * context to re-read), or finished a turn recently enough to be cached.
 */
export function sleepingSince(
  session: Pick<SessionMeta, 'status' | 'started'>,
  events: readonly SessionEvent[],
  now: number
): string | null {
  if (session.status === 'running') return null
  if (!session.started) return null
  const idleSince = idleSinceOf(events)
  if (!idleSince) return null
  if (now - Date.parse(idleSince) < WAKE_THRESHOLD_MS) return null
  return idleSince
}

/** The held messages on a log the user has not decided on yet, oldest first. */
export function pendingHeldMessages(events: readonly SessionEvent[]): HeldMessage[] {
  const decided = new Set<string>()
  for (const event of events) {
    if (event.type === 'user.decide_held_message') decided.add(event.heldId)
  }
  const pending: HeldMessage[] = []
  for (const event of events) {
    if (event.type !== 'app.held_message') continue
    if (decided.has(event.heldId)) continue
    pending.push(heldMessageOf(event))
  }
  return pending
}

/** One held message, whether or not it has been decided. */
export function heldMessageNamed(events: readonly SessionEvent[], heldId: string): HeldMessage | null {
  for (const event of events) {
    if (event.type === 'app.held_message' && event.heldId === heldId) return heldMessageOf(event)
  }
  return null
}

/** Whether a held message was decided before, so a second answer is not acted on twice. */
export function decidedBefore(events: readonly SessionEvent[], heldId: string, seq: number): boolean {
  return events.some(
    (event) => event.type === 'user.decide_held_message' && event.heldId === heldId && event.seq < seq
  )
}

function heldMessageOf(event: Extract<SessionEvent, { type: 'app.held_message' }>): HeldMessage {
  return {
    heldId: event.heldId,
    from: event.from,
    fromSessionId: event.fromSessionId,
    text: event.text,
    idleSince: event.idleSince,
    contextTokens: event.contextTokens,
    wakeCost: event.wakeCost,
    canCompact: event.canCompact
  }
}

/**
 * What sending a context of this size uncached costs. The harness writes it to
 * the cache as it reads it, so it is billed at the cache-write rate where the
 * catalog has one, and at the input rate otherwise. Prices are per million.
 */
export function wakeCostOf(contextTokens: number, pricing: ModelPricing | null): number | null {
  if (!pricing || contextTokens <= 0) return null
  let rate = pricing.input
  if (pricing.cacheWrite > 0) rate = pricing.cacheWrite
  if (!(rate > 0)) return null
  return (contextTokens * rate) / 1_000_000
}
