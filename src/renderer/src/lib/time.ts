// Ages as the UI shows them next to a row: compact ("5h") or as a phrase
// ("5h ago").

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "3m", "5h", "12d" — the compact age gh-dash puts at the end of a row. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = now - new Date(iso).getTime()
  if (Number.isNaN(elapsed)) return '—'
  if (elapsed < MINUTE) return 'now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d`
  return `${Math.floor(elapsed / (30 * DAY))}mo`
}

/** The same age as a sentence: "just now", "4h ago". */
export function ageLabel(iso: string, now: number = Date.now()): string {
  const age = relativeTime(iso, now)
  if (age === 'now') return 'just now'
  return `${age} ago`
}
