// What the search box offers while a qualifier is being typed: the qualifier
// names for a bare word, and the repository's own values once a key and its
// colon are there. Pure, like search.ts, so the rules are pinned by test.

import { CLOSED_WORDS, KEYS, OPEN_WORDS, quoted, type QualifierKey } from './search'
import type {
  GithubActor,
  GithubIssueType,
  GithubLabelDefinition,
  GithubMilestoneDefinition
} from '../../../../../shared/types'

/** A branch the loaded pull requests name, and the pull it is the head of. */
export interface SuggestionBranch {
  name: string
  /** The pull request this branch is the head of, or null for a base only. */
  pull: { number: number; title: string } | null
}

/** Where the values a suggestion can come from are gathered, one list per kind. */
export interface SuggestionSources {
  labels: GithubLabelDefinition[]
  people: GithubActor[]
  /** Whoever `@me` is, so its row can show their avatar; null until it is known. */
  viewer: GithubActor | null
  milestones: GithubMilestoneDefinition[]
  types: GithubIssueType[]
  projects: string[]
  branches: SuggestionBranch[]
}

/** The run of the query under the caret, quote-aware, by character offsets. */
export interface SearchToken {
  start: number
  end: number
  text: string
}

/** What a row draws beside its name: the thing the value stands for on GitHub. */
export type SuggestionDetail =
  | { kind: 'key'; description: string }
  | { kind: 'word'; description: string }
  | { kind: 'person'; actor: GithubActor; isViewer: boolean }
  | { kind: 'label'; label: GithubLabelDefinition }
  | { kind: 'milestone'; milestone: GithubMilestoneDefinition }
  | { kind: 'type'; issueType: GithubIssueType }
  | { kind: 'project' }
  | { kind: 'branch'; branch: SuggestionBranch }

export interface SearchSuggestion {
  /** A qualifier name (`label:`) or one of its values (`bug`). */
  kind: 'key' | 'value'
  /** What the list shows. */
  label: string
  /** What replaces the token when it is accepted. */
  insert: string
  detail: SuggestionDetail
}

/** A value a key can take, before it is matched against what was typed. */
interface Candidate {
  value: string
  detail: SuggestionDetail
}

// What each qualifier narrows to, in the words github.com's own help uses.
const KEY_DESCRIPTIONS: Record<QualifierKey, string> = {
  is: 'State or kind',
  state: 'Open or closed',
  author: 'Opened by',
  assignee: 'Assigned to',
  label: 'Has the label',
  milestone: 'In the milestone',
  type: 'Issue type',
  project: 'On the project board',
  head: 'From the branch',
  base: 'Into the branch',
  no: 'Missing a field'
}

// The words `is:`, `state:` and `no:` understand, and what each one means.
const WORD_DESCRIPTIONS: Record<string, string> = {
  open: 'Still open',
  closed: 'Closed',
  merged: 'Merged pull requests',
  draft: 'Draft pull requests',
  pr: 'Pull requests only',
  issue: 'Issues only',
  label: 'No labels',
  assignee: 'Nobody assigned',
  milestone: 'No milestone',
  type: 'No issue type',
  project: 'On no project board'
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

/** Plain words, each with what it means to the search. */
function words(values: string[]): Candidate[] {
  return values.map((value) => ({
    value,
    detail: { kind: 'word', description: WORD_DESCRIPTIONS[value] }
  }))
}

/** `@me` first, standing for the viewer, then everyone else once each. */
function people(sources: SuggestionSources): Candidate[] {
  let viewer: GithubActor = { login: '@me', avatarUrl: null }
  if (sources.viewer) viewer = sources.viewer
  const candidates: Candidate[] = [
    { value: '@me', detail: { kind: 'person', actor: viewer, isViewer: true } }
  ]
  for (const actor of sources.people) {
    const isViewer = sources.viewer !== null && sources.viewer.login === actor.login
    candidates.push({ value: actor.login, detail: { kind: 'person', actor, isViewer } })
  }
  return candidates
}

/** The values one key can take, as the repository names them. */
function valuesFor(key: QualifierKey, sources: SuggestionSources): Candidate[] {
  if (key === 'is') return words(IS_WORDS)
  if (key === 'state') return words([...OPEN_WORDS, ...CLOSED_WORDS])
  if (key === 'no') return words(NO_WORDS)
  if (key === 'author' || key === 'assignee') return people(sources)
  if (key === 'label') {
    return sources.labels.map((label) => ({ value: label.name, detail: { kind: 'label', label } }))
  }
  if (key === 'milestone') {
    return sources.milestones.map((milestone) => ({
      value: milestone.title,
      detail: { kind: 'milestone', milestone }
    }))
  }
  if (key === 'type') {
    return sources.types.map((issueType) => ({
      value: issueType.name,
      detail: { kind: 'type', issueType }
    }))
  }
  if (key === 'project') {
    return sources.projects.map((project) => ({ value: project, detail: { kind: 'project' } }))
  }
  return sources.branches.map((branch) => ({
    value: branch.name,
    detail: { kind: 'branch', branch }
  }))
}

/**
 * The candidates whose value contains `partial`, those starting with it first,
 * each group in its given order, each value once. A candidate that already is
 * the partial is left out: the value is written, there is nothing left to offer.
 */
function rank(candidates: Candidate[], partial: string, limit: number): Candidate[] {
  const needle = partial.toLowerCase()
  const seen = new Set<string>()
  const starting: Candidate[] = []
  const containing: Candidate[] = []
  for (const candidate of candidates) {
    const folded = candidate.value.toLowerCase()
    if (seen.has(folded) || folded === needle) continue
    seen.add(folded)
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
    .map((key) => ({
      kind: 'key',
      label: `${negation}${key}:`,
      insert: `${negation}${key}:`,
      detail: { kind: 'key', description: KEY_DESCRIPTIONS[key] }
    }))
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
  return rank(valuesFor(key, sources), partial, limit).map((candidate) => ({
    kind: 'value',
    label: candidate.value,
    insert: `${negation}${key}:${quoted(candidate.value)}`,
    detail: candidate.detail
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

/**
 * A milestone's standing as its row shows it: closed, past due, due on a date,
 * or null when it is open with no date. Dates are compared by day, so a
 * milestone due today is not yet past due.
 */
export function milestoneStanding(milestone: GithubMilestoneDefinition, now: Date): string | null {
  if (milestone.state.toUpperCase() === 'CLOSED') return 'Closed'
  if (milestone.dueOn === null) return null
  const due = new Date(milestone.dueOn)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (due.getTime() < today.getTime()) return 'Past due'
  const date = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `Due ${date}`
}

/** How far through its issues a milestone is, as a whole percentage. */
export function milestoneProgress(milestone: GithubMilestoneDefinition): number {
  const total = milestone.openIssues + milestone.closedIssues
  if (total === 0) return 0
  return Math.round((milestone.closedIssues / total) * 100)
}
