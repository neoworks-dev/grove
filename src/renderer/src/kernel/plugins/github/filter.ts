// Pure helpers behind the GitHub pane: the client-side search, the age labels
// and the small vocabulary that turns GitHub's enums into colours and words.
// Kept free of runes and `window` so they can be unit-tested directly.

import type { GithubItem } from '../../../../../shared/types'

/** A colour token from the app palette, used for status text and dots. */
export type Tone = 'green' | 'red' | 'amber' | 'violet' | 'blue' | 'dim'

/**
 * Does the item match a search term? Matches the number (with or without `#`),
 * the title, the author, a label name, or an assignee — all case-insensitive.
 */
export function matchesQuery(item: GithubItem, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  if (needle.startsWith('#') && String(item.number).startsWith(needle.slice(1))) return true
  const haystack = [
    String(item.number),
    item.title,
    item.author,
    ...item.labels.map((label) => label.name),
    ...item.assignees
  ]
  return haystack.some((field) => field.toLowerCase().includes(needle))
}

/** Search a list, keeping GitHub's most-recently-updated-first order. */
export function filterItems<T extends GithubItem>(items: T[], query: string): T[] {
  return items.filter((item) => matchesQuery(item, query))
}

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

/** Colour for a check rollup state. */
export function checkTone(state: string | null): Tone {
  if (state === 'SUCCESS') return 'green'
  if (state === 'FAILURE' || state === 'ERROR') return 'red'
  if (state === 'PENDING' || state === 'EXPECTED') return 'amber'
  return 'dim'
}

/** One-glyph summary of a check rollup, or null when the PR has no checks. */
export function checkGlyph(state: string | null): string | null {
  if (state === null) return null
  if (state === 'SUCCESS') return '✓'
  if (state === 'FAILURE' || state === 'ERROR') return '✕'
  return '•'
}

/** Short words for GitHub's review decisions; null when review is not started. */
export function reviewLabel(decision: string | null | undefined): string | null {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes'
  if (decision === 'REVIEW_REQUIRED') return 'review'
  return null
}

export function reviewTone(decision: string | null | undefined): Tone {
  if (decision === 'APPROVED') return 'green'
  if (decision === 'CHANGES_REQUESTED') return 'red'
  return 'dim'
}

/** Colour for an item's own state (open / closed / merged / draft). */
export function stateTone(item: GithubItem): Tone {
  if (item.kind === 'pull' && item.isDraft) return 'dim'
  if (item.state === 'MERGED') return 'violet'
  if (item.state === 'CLOSED') return 'red'
  return 'green'
}

/**
 * Whether a label chip needs light or dark text over GitHub's background
 * colour, using the standard luminance cutoff.
 */
export function labelIsDark(color: string): boolean {
  const hex = color.replace('#', '')
  if (hex.length !== 6) return true
  const red = parseInt(hex.slice(0, 2), 16)
  const green = parseInt(hex.slice(2, 4), 16)
  const blue = parseInt(hex.slice(4, 6), 16)
  return (red * 299 + green * 587 + blue * 114) / 1000 < 140
}

/** Actions offered for an item, given its kind and current state. */
export function availableActions(item: {
  kind: GithubItem['kind']
  state: string
  isDraft?: boolean
}): ('close' | 'reopen' | 'ready' | 'merge')[] {
  if (item.state === 'MERGED') return []
  if (item.state === 'CLOSED') return ['reopen']
  if (item.kind === 'issue') return ['close']
  if (item.isDraft) return ['ready', 'close']
  return ['merge', 'close']
}
