// What the search box offers while a qualifier is being typed: the qualifier
// names for a bare word, and the repository's own values once a key and its
// colon are there. Pure, like search.ts, so the rules are pinned by test.

import { CLOSED_WORDS, KEYS, OPEN_WORDS, quoted, type QualifierKey } from './search'

/** Where the words a suggestion can come from are gathered, one list per kind. */
export interface SuggestionSources {
  labels: string[]
  people: string[]
  milestones: string[]
  types: string[]
  projects: string[]
  branches: string[]
}

/** The run of the query under the caret, quote-aware, by character offsets. */
export interface SearchToken {
  start: number
  end: number
  text: string
}

export interface SearchSuggestion {
  /** A qualifier name (`label:`) or one of its values (`bug`). */
  kind: 'key' | 'value'
  /** What the list shows. */
  label: string
  /** What replaces the token when it is accepted. */
  insert: string
}

// The words `is:` and `no:` understand, in the order search.ts answers them.
const IS_WORDS = [...OPEN_WORDS, ...CLOSED_WORDS, 'draft', 'pr', 'issue']
const NO_WORDS = ['label', 'assignee', 'milestone', 'type', 'project']

/** Every token of the query with where it starts and ends; quotes keep spaces in. */
function tokenSpans(query: string): SearchToken[] {
  const spans: SearchToken[] = []
  let start = -1
  let quotedRun = false
  for (let index = 0; index <= query.length; index += 1) {
    const character = query[index]
    const atBoundary = index === query.length || (!quotedRun && /\s/.test(character))
    if (atBoundary) {
      if (start !== -1) spans.push({ start, end: index, text: query.slice(start, index) })
      start = -1
      continue
    }
    if (start === -1) start = index
    if (character === '"') quotedRun = !quotedRun
  }
  return spans
}

/** The token the caret sits in or at the end of; empty between two tokens. */
export function tokenAt(query: string, caret: number): SearchToken {
  for (const span of tokenSpans(query)) {
    if (span.start <= caret && caret <= span.end) return span
  }
  return { start: caret, end: caret, text: '' }
}

/** The values one key can take, as the repository names them. */
function valuesFor(key: QualifierKey, sources: SuggestionSources): string[] {
  if (key === 'is') return IS_WORDS
  if (key === 'state') return [...OPEN_WORDS, ...CLOSED_WORDS]
  if (key === 'no') return NO_WORDS
  if (key === 'author' || key === 'assignee') return ['@me', ...sources.people]
  if (key === 'label') return sources.labels
  if (key === 'milestone') return sources.milestones
  if (key === 'type') return sources.types
  if (key === 'project') return sources.projects
  return sources.branches
}

/**
 * The candidates that contain `partial`, those starting with it first, each
 * group in its given order. A candidate that already is the partial is left
 * out: the value is written, there is nothing left to offer.
 */
function rank(candidates: string[], partial: string, limit: number): string[] {
  const needle = partial.toLowerCase()
  const starting: string[] = []
  const containing: string[] = []
  for (const candidate of new Set(candidates)) {
    const folded = candidate.toLowerCase()
    if (folded === needle) continue
    if (folded.startsWith(needle)) {
      starting.push(candidate)
      continue
    }
    if (folded.includes(needle)) containing.push(candidate)
  }
  return [...starting, ...containing].slice(0, limit)
}

/** The qualifier names a bare word could be the start of. */
function suggestKeys(negation: string, word: string, limit: number): SearchSuggestion[] {
  if (word.length === 0) return []
  const needle = word.toLowerCase()
  return KEYS.filter((key) => key.startsWith(needle))
    .slice(0, limit)
    .map((key) => ({ kind: 'key', label: `${negation}${key}:`, insert: `${negation}${key}:` }))
}

/** What to offer for the token under the caret, or nothing when it is plain text. */
export function suggestSearch(
  token: string,
  sources: SuggestionSources,
  limit: number
): SearchSuggestion[] {
  const match = /^(-?)([a-zA-Z-]*)(:?)(.*)$/.exec(token)
  if (!match) return []
  const [, negation, name, colon, rest] = match
  if (colon.length === 0) return suggestKeys(negation, name, limit)

  const key = name.toLowerCase() as QualifierKey
  if (!KEYS.includes(key)) return []
  const partial = rest.replaceAll('"', '')
  return rank(valuesFor(key, sources), partial, limit).map((value) => ({
    kind: 'value',
    label: value,
    insert: `${negation}${key}:${quoted(value)}`
  }))
}

/**
 * The query with the token replaced by the suggestion, and where the caret goes.
 * A value ends the qualifier, so a space follows it and the caret lands after,
 * ready for the next one; a key leaves the caret on its colon for the value.
 */
export function applySuggestion(
  query: string,
  token: SearchToken,
  suggestion: SearchSuggestion
): { text: string; caret: number } {
  const before = query.slice(0, token.start)
  let after = query.slice(token.end)
  let insert = suggestion.insert
  if (suggestion.kind === 'value') {
    insert += ' '
    after = after.replace(/^\s+/, '')
  }
  return { text: before + insert + after, caret: before.length + insert.length }
}
