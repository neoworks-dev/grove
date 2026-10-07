// What waking a sleeping session for a held message would mean, in the words
// the held-message card shows: how long it has slept, so the user can tell its
// cache is cold, and how much context it would re-read, with the price when the
// model's is known.

import type { HeldMessage } from './types'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** How long ago something was, in the largest whole unit: "3 days", "1 hour". */
export function elapsed(sinceMs: number, nowMs: number): string {
  const span = Math.max(0, nowMs - sinceMs)
  if (span >= DAY_MS) return plural(Math.floor(span / DAY_MS), 'day')
  if (span >= HOUR_MS) return plural(Math.floor(span / HOUR_MS), 'hour')
  return plural(Math.max(1, Math.floor(span / MINUTE_MS)), 'minute')
}

/** A token count as it reads at a glance: 840, 12k, 1.2M. */
export function tokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimmed(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/** A dollar amount, with cents below ten dollars. */
export function dollars(amount: number): string {
  if (amount >= 10) return `$${Math.round(amount)}`
  if (amount < 0.01) return '<$0.01'
  return `$${amount.toFixed(2)}`
}

/**
 * The line under a held message: how long the session has slept and what
 * waking it costs. Sessions with nothing measured yet say only how long.
 */
export function wakeSummary(held: HeldMessage, nowMs: number): string {
  const asleep = `Idle for ${elapsed(Date.parse(held.idleSince), nowMs)}, so its cache is cold.`
  if (held.contextTokens <= 0) return asleep
  let cost = ''
  if (held.wakeCost !== null) cost = `, about ${dollars(held.wakeCost)}`
  return `${asleep} Sending this re-reads ${tokenCount(held.contextTokens)} tokens of context${cost}.`
}

function plural(count: number, unit: string): string {
  if (count === 1) return `1 ${unit}`
  return `${count} ${unit}s`
}

/** One decimal place, dropped when it is zero: 1.2, 3. */
function trimmed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}
