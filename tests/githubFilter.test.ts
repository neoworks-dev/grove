// The GitHub pane's client-side vocabulary: what the search box matches, how an
// item's age reads, and which actions an item's state allows.

import { describe, it, expect } from 'bun:test'
import {
  ageLabel,
  availableActions,
  filterItems,
  labelIsDark,
  matchesQuery,
  relativeTime,
  reviewLabel,
  stateTone
} from '../src/renderer/src/kernel/plugins/github/filter'
import type { GithubIssueItem, GithubPullItem } from '../src/shared/types'

function issue(overrides: Partial<GithubIssueItem> = {}): GithubIssueItem {
  return {
    kind: 'issue',
    number: 42,
    title: 'Crash when opening a worktree',
    url: 'https://github.com/acme/grove/issues/42',
    state: 'OPEN',
    author: 'moritz',
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z',
    commentCount: 3,
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: ['ada'],
    ...overrides
  }
}

function pull(overrides: Partial<GithubPullItem> = {}): GithubPullItem {
  return {
    ...issue(),
    kind: 'pull',
    number: 7,
    isDraft: false,
    additions: 10,
    deletions: 2,
    headRefName: 'fix/crash',
    baseRefName: 'main',
    reviewDecision: null,
    checks: 'SUCCESS',
    ...overrides
  }
}

describe('matchesQuery', () => {
  it('matches an empty query', () => {
    expect(matchesQuery(issue(), '   ')).toBe(true)
  })

  it('matches title, author, label and assignee case-insensitively', () => {
    expect(matchesQuery(issue(), 'CRASH')).toBe(true)
    expect(matchesQuery(issue(), 'moritz')).toBe(true)
    expect(matchesQuery(issue(), 'bug')).toBe(true)
    expect(matchesQuery(issue(), 'ada')).toBe(true)
    expect(matchesQuery(issue(), 'unrelated')).toBe(false)
  })

  it('matches a number with or without the hash', () => {
    expect(matchesQuery(issue(), '42')).toBe(true)
    expect(matchesQuery(issue(), '#42')).toBe(true)
    expect(matchesQuery(issue(), '#43')).toBe(false)
  })

  it('keeps the incoming order when filtering', () => {
    const items = [issue({ number: 1 }), issue({ number: 2, title: 'Other' }), issue({ number: 3 })]
    expect(filterItems(items, 'crash').map((item) => item.number)).toEqual([1, 3])
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-09-18T12:00:00Z')

  it('reads in the largest unit that fits', () => {
    expect(relativeTime('2026-09-18T11:59:30Z', now)).toBe('now')
    expect(relativeTime('2026-09-18T11:30:00Z', now)).toBe('30m')
    expect(relativeTime('2026-09-18T07:00:00Z', now)).toBe('5h')
    expect(relativeTime('2026-09-10T12:00:00Z', now)).toBe('8d')
    expect(relativeTime('2026-06-18T12:00:00Z', now)).toBe('3mo')
  })

  it('degrades to a dash on an unparseable date', () => {
    expect(relativeTime('not-a-date', now)).toBe('—')
  })

  it('reads as a sentence in the thread, without "now ago"', () => {
    expect(ageLabel('2026-09-18T11:59:30Z', now)).toBe('just now')
    expect(ageLabel('2026-09-18T07:00:00Z', now)).toBe('5h ago')
  })
})

describe('item state vocabulary', () => {
  it('colours merged, closed, draft and open apart', () => {
    expect(stateTone(pull({ state: 'MERGED' }))).toBe('violet')
    expect(stateTone(issue({ state: 'CLOSED' }))).toBe('red')
    expect(stateTone(pull({ isDraft: true }))).toBe('dim')
    expect(stateTone(issue())).toBe('green')
  })

  it('names only the decisions worth showing', () => {
    expect(reviewLabel('APPROVED')).toBe('approved')
    expect(reviewLabel('CHANGES_REQUESTED')).toBe('changes')
    expect(reviewLabel(null)).toBe(null)
  })

  it('picks readable text for a label chip', () => {
    expect(labelIsDark('0b0b0d')).toBe(true)
    expect(labelIsDark('d4c5f9')).toBe(false)
  })
})

describe('availableActions', () => {
  it('offers only reopen on a closed item, and nothing on a merged one', () => {
    expect(availableActions({ kind: 'issue', state: 'CLOSED' })).toEqual(['reopen'])
    expect(availableActions({ kind: 'pull', state: 'MERGED' })).toEqual([])
  })

  it('never offers merge on an issue', () => {
    expect(availableActions({ kind: 'issue', state: 'OPEN' })).toEqual(['close'])
  })

  it('asks a draft to become ready before it can be merged', () => {
    expect(availableActions({ kind: 'pull', state: 'OPEN', isDraft: true })).toEqual([
      'ready',
      'close'
    ])
    expect(availableActions({ kind: 'pull', state: 'OPEN', isDraft: false })).toEqual([
      'merge',
      'close'
    ])
  })
})
