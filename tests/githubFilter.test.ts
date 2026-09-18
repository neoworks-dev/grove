// The GitHub pane's client-side vocabulary: what the search box matches, how an
// item's age reads, and which actions an item's state allows.

import { describe, it, expect } from 'bun:test'
import {
  ageLabel,
  availableActions,
  filterItems,
  issueTypeColour,
  matchesFilters,
  authorsOf,
  NO_FILTERS,
  matchesQuery,
  projectsOf,
  relativeTime,
  reviewLabel,
  stateTone,
  typesOf
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

// The list bar narrows by author and label on top of the search box. Which
// items survive is decided here rather than in the component, so the rules can
// be pinned without a DOM.
describe('matchesFilters', () => {
  const base = {
    kind: 'issue' as const,
    url: '',
    state: 'OPEN',
    createdAt: '2026-09-18T10:00:00Z',
    updatedAt: '2026-09-18T10:00:00Z',
    assignees: [],
    commentCount: 0
  }
  const bug = {
    ...base,
    number: 1,
    title: 'Terminal takes no mouse input',
    author: 'Letsmoe',
    labels: [
      { name: 'bug', color: 'ff0000' },
      { name: 'area:terminal', color: '00ff00' }
    ]
  }
  const feature = {
    ...base,
    number: 2,
    title: 'Smooth scrolling',
    author: 'claude',
    labels: [{ name: 'enhancement', color: '0000ff' }]
  }

  it('keeps everything when nothing is narrowed', () => {
    expect(filterItems([bug, feature], NO_FILTERS)).toHaveLength(2)
  })

  it('narrows to the chosen authors', () => {
    const kept = filterItems([bug, feature], { ...NO_FILTERS, authors: ['claude'] })
    expect(kept.map((item) => item.number)).toEqual([2])
  })

  it('offers several authors at once', () => {
    const kept = filterItems([bug, feature], { ...NO_FILTERS, authors: ['claude', 'Letsmoe'] })
    expect(kept).toHaveLength(2)
  })

  it('requires every chosen label, not any of them', () => {
    const both = filterItems([bug, feature], {
      ...NO_FILTERS,
      labels: ['bug', 'area:terminal']
    })
    expect(both.map((item) => item.number)).toEqual([1])
    const impossible = filterItems([bug, feature], {
      ...NO_FILTERS,
      labels: ['bug', 'enhancement']
    })
    expect(impossible).toEqual([])
  })

  it('applies the search box alongside the menus', () => {
    const kept = filterItems([bug, feature], {
      ...NO_FILTERS,
      authors: ['Letsmoe'],
      query: 'scrolling'
    })
    expect(kept).toEqual([])
  })

  it('still accepts a bare query string', () => {
    expect(filterItems([bug, feature], 'terminal').map((item) => item.number)).toEqual([1])
  })

  // Milestones, types and boards are OR — GitHub narrows to any of the chosen
  // ones, unlike labels — and an item that carries none of them drops out.
  const milestoned = {
    ...feature,
    number: 3,
    milestone: { number: 1, title: 'v1.0', state: 'open', dueOn: null },
    issueType: { name: 'Feature', color: 'BLUE' },
    projects: [{ number: 4, title: 'Roadmap', url: '' }]
  }

  it('narrows to any of the chosen milestones', () => {
    const kept = filterItems([bug, milestoned], { ...NO_FILTERS, milestones: ['v1.0', 'v2.0'] })
    expect(kept.map((item) => item.number)).toEqual([3])
  })

  it('narrows to any of the chosen issue types', () => {
    const kept = filterItems([bug, milestoned], { ...NO_FILTERS, types: ['Feature'] })
    expect(kept.map((item) => item.number)).toEqual([3])
  })

  it('narrows to any of the chosen boards', () => {
    const kept = filterItems([bug, milestoned], { ...NO_FILTERS, projects: ['Roadmap'] })
    expect(kept.map((item) => item.number)).toEqual([3])
  })

  it('drops an item the query could not ask about', () => {
    expect(filterItems([bug], { ...NO_FILTERS, projects: ['Roadmap'] })).toEqual([])
  })
})

describe('typesOf and projectsOf', () => {
  const base = {
    kind: 'issue' as const,
    url: '',
    state: 'OPEN',
    createdAt: '2026-09-18T10:00:00Z',
    updatedAt: '2026-09-18T10:00:00Z',
    assignees: [],
    labels: [],
    commentCount: 0,
    author: 'claude',
    title: ''
  }

  it('lists each type and board once, alphabetically', () => {
    const items = [
      { ...base, number: 1, issueType: { name: 'Task', color: 'GRAY' }, projects: [] },
      {
        ...base,
        number: 2,
        issueType: { name: 'Bug', color: 'RED' },
        projects: [{ number: 1, title: 'Roadmap', url: '' }]
      },
      {
        ...base,
        number: 3,
        issueType: { name: 'Bug', color: 'RED' },
        projects: [{ number: 1, title: 'Roadmap', url: '' }]
      }
    ]
    expect(typesOf(items)).toEqual(['Bug', 'Task'])
    expect(projectsOf(items)).toEqual(['Roadmap'])
  })

  it('skips items the query could not ask about', () => {
    expect(typesOf([{ ...base, number: 1 }])).toEqual([])
    expect(projectsOf([{ ...base, number: 1 }])).toEqual([])
  })
})

describe('issueTypeColour', () => {
  it('resolves GitHub palette names to hex', () => {
    expect(issueTypeColour('RED')).toBe('d1242f')
    expect(issueTypeColour('blue')).toBe('0969da')
  })

  it('falls back to grey for a name it does not know', () => {
    expect(issueTypeColour('CHARTREUSE')).toBe('59636e')
  })
})

describe('authorsOf', () => {
  it('lists each author once, alphabetically', () => {
    const items = [
      { author: 'zoe' },
      { author: 'adam' },
      { author: 'zoe' }
    ] as unknown as Parameters<typeof authorsOf>[0]
    expect(authorsOf(items)).toEqual(['adam', 'zoe'])
  })
})
