// Pure helpers behind the GitHub pane: the client-side search, the age labels
// and the small vocabulary that turns GitHub's enums into colours and words.
// Kept free of runes and `window` so they can be unit-tested directly.

import type { GithubItem, GithubItemKind } from '../../../../../shared/types'

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

// The narrowing that used to live here — an ItemFilters record of arrays, one
// per menu — is now search.ts: the query string is the only place a filter is
// written down, so the menus and the box cannot disagree.

/** Every author present in a list, alphabetical — the options the menu offers. */
export function authorsOf(items: GithubItem[]): string[] {
  return uniqueSorted(items.map((item) => item.author))
}

/**
 * Every issue type present in a list, alphabetical. Types and projects are read
 * off the loaded items rather than from the repository: the menu only narrows
 * what is on screen, so offering one nothing here carries would filter to
 * nothing and say nothing about why.
 */
export function typesOf(items: GithubItem[]): string[] {
  return uniqueSorted(items.flatMap((item) => (item.issueType ? [item.issueType.name] : [])))
}

/** Every project board present in a list, alphabetical. */
export function projectsOf(items: GithubItem[]): string[] {
  const titles = items.flatMap((item) => {
    if (!item.projects) return []
    return item.projects.map((project) => project.title)
  })
  return uniqueSorted(titles)
}

// GitHub gives an issue type a colour by name from its own palette rather than
// as a hex, so these are what those names resolve to. With one, a type can be
// drawn through the same pill a label uses.
const ISSUE_TYPE_COLOURS: Record<string, string> = {
  RED: 'd1242f',
  ORANGE: 'bc4c00',
  YELLOW: '9a6700',
  GREEN: '1a7f37',
  BLUE: '0969da',
  PURPLE: '8250df',
  PINK: 'bf3989',
  GRAY: '59636e'
}

/** Six-digit hex for an issue type's palette name; grey when it is unknown. */
export function issueTypeColour(palette: string): string {
  const hex = ISSUE_TYPE_COLOURS[palette.toUpperCase()]
  if (hex === undefined) return ISSUE_TYPE_COLOURS.GRAY
  return hex
}

function uniqueSorted(values: string[]): string[] {
  const collected: string[] = []
  for (const value of values) {
    if (collected.includes(value)) continue
    collected.push(value)
  }
  return collected.sort((left, right) => left.localeCompare(right))
}

export { relativeTime, ageLabel } from '../../../lib/time'

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
export function stateTone(item: { kind: GithubItemKind; state: string; isDraft?: boolean }): Tone {
  if (item.kind === 'pull' && item.isDraft) return 'dim'
  if (item.state === 'MERGED') return 'violet'
  if (item.state === 'CLOSED') return 'red'
  return 'green'
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
