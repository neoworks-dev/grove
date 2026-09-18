// GitHub's search syntax, as far as the loaded items can answer it.
//
// The query string is the one source of truth for what the list is showing:
// the menus write qualifiers into it and read their ticks back out of it, so
// what is on screen can always be copied out, pasted in, or just read. That is
// the whole reason this is a string and not a set of arrays.
//
// Everything here is pure and free of runes, so the rules can be pinned by test
// rather than by looking at a list and counting rows.

import { matchesQuery } from './filter'
import type { GithubItem, GithubStateFilter } from '../../../../../shared/types'

export type QualifierKey =
  | 'is'
  | 'state'
  | 'author'
  | 'assignee'
  | 'label'
  | 'milestone'
  | 'type'
  | 'project'
  | 'head'
  | 'base'
  | 'no'

const KEYS: QualifierKey[] = [
  'is',
  'state',
  'author',
  'assignee',
  'label',
  'milestone',
  'type',
  'project',
  'head',
  'base',
  'no'
]

/**
 * Keys whose repeats narrow rather than widen. GitHub does this for labels —
 * two of them mean both — and `is:` needs it for a different reason: `is:pr`
 * and `is:open` are different questions that happen to share a key.
 */
const ALL_OF_KEYS: QualifierKey[] = ['is', 'state', 'label', 'no']

/** The states `is:` and `state:` can name, which are also what a fetch covers. */
const OPEN_WORDS = ['open']
const CLOSED_WORDS = ['closed', 'merged']

export interface Qualifier {
  key: QualifierKey
  value: string
  /** From a leading `-`: the item must *not* answer to this. */
  negated: boolean
}

export interface SearchQuery {
  /** Everything that was not a qualifier, as one free-text needle. */
  text: string
  qualifiers: Qualifier[]
}

/** What the list starts on, and what GitHub's own issue view opens with. */
export const DEFAULT_QUERY = 'is:open'

/**
 * Split on whitespace, keeping quoted runs together and dropping the quotes.
 * A quote can open anywhere, which is what lets `label:"good first issue"`
 * arrive as one token with its key still attached.
 */
function tokenize(query: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (const character of query) {
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(character)) {
      if (current.length > 0) tokens.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** One token as a qualifier, or null when it is just words to search for. */
function toQualifier(token: string): Qualifier | null {
  const match = /^(-?)([a-zA-Z-]+):(.*)$/.exec(token)
  if (!match) return null
  const key = match[2].toLowerCase() as QualifierKey
  if (!KEYS.includes(key)) return null
  if (match[3].length === 0) return null
  return { key, value: match[3], negated: match[1] === '-' }
}

/** A query string as its qualifiers and whatever text was left over. */
export function parseSearch(query: string): SearchQuery {
  const qualifiers: Qualifier[] = []
  const words: string[] = []
  for (const token of tokenize(query)) {
    const qualifier = toQualifier(token)
    if (qualifier) {
      qualifiers.push(qualifier)
      continue
    }
    words.push(token)
  }
  return { text: words.join(' '), qualifiers }
}

/** A value as it has to be written to survive another parse. */
function quoted(value: string): string {
  if (!/\s/.test(value)) return value
  return `"${value}"`
}

/** The query string a parsed search writes back out to. */
export function stringifySearch(search: SearchQuery): string {
  const parts = search.qualifiers.map((qualifier) => {
    let prefix = ''
    if (qualifier.negated) prefix = '-'
    return `${prefix}${qualifier.key}:${quoted(qualifier.value)}`
  })
  if (search.text.length > 0) parts.push(search.text)
  return parts.join(' ')
}

/** Values a key carries, in the order they were written. */
export function valuesOf(search: SearchQuery, key: QualifierKey): string[] {
  return search.qualifiers
    .filter((qualifier) => qualifier.key === key && !qualifier.negated)
    .map((qualifier) => qualifier.value)
}

function sameValue(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * The query with one qualifier put in, or taken out when it was already there.
 * This is what a menu click does, and why picking a label and typing its
 * qualifier by hand end in the same place.
 */
export function toggleQualifier(query: string, key: QualifierKey, value: string): string {
  const search = parseSearch(query)
  const without = search.qualifiers.filter((qualifier) => {
    if (qualifier.key !== key || qualifier.negated) return true
    return !sameValue(qualifier.value, value)
  })
  if (without.length < search.qualifiers.length) {
    return stringifySearch({ ...search, qualifiers: without })
  }
  return stringifySearch({
    ...search,
    qualifiers: [...search.qualifiers, { key, value, negated: false }]
  })
}

/**
 * The query with its state replaced. Only the words that name a state are
 * dropped — `is:draft` and `is:pr` are the same key asking something else, and
 * changing the dropdown should leave them alone.
 */
export function setStateQualifier(query: string, state: GithubStateFilter): string {
  const search = parseSearch(query)
  const kept = search.qualifiers.filter((qualifier) => {
    if (qualifier.key === 'state') return false
    if (qualifier.key !== 'is') return true
    return !isStateWord(qualifier.value)
  })
  if (state === 'all') return stringifySearch({ ...search, qualifiers: kept })
  return stringifySearch({
    ...search,
    qualifiers: [{ key: 'is', value: state, negated: false }, ...kept]
  })
}

function isStateWord(value: string): boolean {
  const word = value.toLowerCase()
  return OPEN_WORDS.includes(word) || CLOSED_WORDS.includes(word)
}

/**
 * Which states a fetch has to cover for the query to be answerable at all.
 * `is:` drives this so the dropdown and the query cannot disagree about what is
 * on screen: asking for closed items the fetch never brought back would empty
 * the list with nothing to say about why.
 */
export function stateFilterFor(search: SearchQuery): GithubStateFilter {
  const named: string[] = []
  for (const qualifier of search.qualifiers) {
    if (qualifier.key !== 'is' && qualifier.key !== 'state') continue
    // A negated state says nothing about what is *not* needed, so play safe.
    if (qualifier.negated) return 'all'
    if (isStateWord(qualifier.value)) named.push(qualifier.value.toLowerCase())
  }
  if (named.length === 0) return 'all'
  if (named.every((word) => OPEN_WORDS.includes(word))) return 'open'
  if (named.every((word) => CLOSED_WORDS.includes(word))) return 'closed'
  return 'all'
}

/** Case-insensitive membership, which is how GitHub compares names. */
function includesValue(haystack: string[], value: string): boolean {
  return haystack.some((entry) => sameValue(entry, value))
}

/** The login a value names, resolving GitHub's `@me`. */
function loginFor(value: string, viewer: string | null): string {
  if (value !== '@me') return value
  if (viewer === null) return value
  return viewer
}

/** Whether the item answers to one `is:` word, or null when the word is not one. */
function holdsIs(item: GithubItem, value: string): boolean | null {
  const word = value.toLowerCase()
  if (word === 'open') return item.state === 'OPEN'
  if (word === 'closed') return item.state === 'CLOSED' || item.state === 'MERGED'
  if (word === 'merged') return item.state === 'MERGED'
  if (word === 'draft') return item.kind === 'pull' && item.isDraft === true
  if (word === 'issue') return item.kind === 'issue'
  if (word === 'pr') return item.kind === 'pull'
  return null
}

/** Whether the item is missing whatever a `no:` word names. */
function holdsNo(item: GithubItem, value: string): boolean | null {
  const word = value.toLowerCase()
  if (word === 'label') return item.labels.length === 0
  if (word === 'assignee') return item.assignees.length === 0
  if (word === 'milestone') return !item.milestone
  if (word === 'type') return !item.issueType
  if (word === 'project') return !item.projects || item.projects.length === 0
  return null
}

/**
 * Whether one qualifier holds for one item. Null means the question itself was
 * not one we know — `is:banana` — and an unanswerable question is not a reason
 * to hide anything, so half-typed qualifiers do not blank the list.
 *
 * Metadata the query could not ask GitHub for answers false rather than null:
 * "not as far as we know" is the honest answer, and it is the one that keeps
 * `project:` from matching everything when the scope was never granted.
 */
function holds(
  item: GithubItem,
  key: QualifierKey,
  value: string,
  viewer: string | null
): boolean | null {
  if (key === 'is' || key === 'state') return holdsIs(item, value)
  if (key === 'no') return holdsNo(item, value)
  if (key === 'author') return sameValue(item.author, loginFor(value, viewer))
  if (key === 'assignee') return includesValue(item.assignees, loginFor(value, viewer))
  if (key === 'label')
    return includesValue(
      item.labels.map((label) => label.name),
      value
    )
  if (key === 'milestone') {
    if (!item.milestone) return false
    return sameValue(item.milestone.title, value)
  }
  if (key === 'type') {
    if (!item.issueType) return false
    return sameValue(item.issueType.name, value)
  }
  if (key === 'project') {
    if (!item.projects) return false
    return item.projects.some((project) => sameValue(project.title, value))
  }
  if (key === 'head') {
    if (item.kind !== 'pull') return false
    return sameValue(item.headRefName, value)
  }
  if (item.kind !== 'pull') return false
  return sameValue(item.baseRefName, value)
}

/** Whether the item satisfies every qualifier written under one key. */
function satisfiesKey(
  item: GithubItem,
  key: QualifierKey,
  qualifiers: Qualifier[],
  viewer: string | null
): boolean {
  for (const qualifier of qualifiers) {
    if (!qualifier.negated) continue
    if (holds(item, key, qualifier.value, viewer) === true) return false
  }

  const wanted = qualifiers.filter((qualifier) => !qualifier.negated)
  if (wanted.length === 0) return true
  const answers = wanted
    .map((qualifier) => holds(item, key, qualifier.value, viewer))
    .filter((answer): answer is boolean => answer !== null)
  if (answers.length === 0) return true
  if (ALL_OF_KEYS.includes(key)) return answers.every((answer) => answer)
  return answers.some((answer) => answer)
}

/** Whether an item survives the whole query, text and qualifiers together. */
export function matchesSearch(
  item: GithubItem,
  search: SearchQuery,
  viewer: string | null
): boolean {
  if (!matchesQuery(item, search.text)) return false
  return KEYS.every((key) => {
    const forKey = search.qualifiers.filter((qualifier) => qualifier.key === key)
    if (forKey.length === 0) return true
    return satisfiesKey(item, key, forKey, viewer)
  })
}

/** Search a list, keeping GitHub's most-recently-updated-first order. */
export function filterItems<T extends GithubItem>(
  items: T[],
  search: SearchQuery,
  viewer: string | null
): T[] {
  return items.filter((item) => matchesSearch(item, search, viewer))
}
