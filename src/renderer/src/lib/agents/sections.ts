/**
 * Transcript items → sections, one per user message, each knowing whether its turn is over.
 *
 * A section ends where the next user message starts, but a turn does not: a message steered
 * into a running turn opens a new section while the agent carries on with the same turn. So
 * whether a section is settled — and may fold its work away — is decided by when the turn in
 * flight started, not by whether another section follows it. Settling every section but the
 * last made a steered message fold the calls the agent had just made out of sight mid-turn.
 */

import type { TranscriptItem } from './transcript'

export interface TranscriptSection {
  key: string
  header: TranscriptItem | null
  body: TranscriptItem[]
  /** Its turn is over, so its work may fold; false while the agent is still on it. */
  settled: boolean
}

/**
 * Groups items into sections under the user message that opened each, and marks which are
 * settled. `turnInFlightSince` is the seq the running turn started at, or null when idle.
 */
export function sectionsOf(
  items: TranscriptItem[],
  turnInFlightSince: number | null
): TranscriptSection[] {
  const sections = groupSections(items)
  for (let index = 0; index < sections.length; index++) {
    const next = sections[index + 1]
    sections[index].settled = isSettled(next, turnInFlightSince)
  }
  return sections
}

/** Splits items at each user message; the items before the first form a headerless lead. */
function groupSections(items: TranscriptItem[]): TranscriptSection[] {
  const sections: TranscriptSection[] = []
  let current: TranscriptSection = { key: 'lead', header: null, body: [], settled: true }
  for (const item of items) {
    if (item.kind !== 'user') {
      current.body.push(item)
      continue
    }
    if (current.header || current.body.length > 0) sections.push(current)
    current = { key: item.eventId, header: item, body: [], settled: true }
  }
  if (current.header || current.body.length > 0) sections.push(current)
  return sections
}

/**
 * A section is settled unless the turn in flight runs through it: it is the last section, or
 * the message after it was written once that turn had already started — steered into it.
 * A message that started the turn, or was queued for it, lands before its start.
 */
function isSettled(next: TranscriptSection | undefined, turnInFlightSince: number | null): boolean {
  if (turnInFlightSince === null) {
    return true
  }
  if (!next || !next.header) {
    return false
  }
  return next.header.seq < turnInFlightSince
}
