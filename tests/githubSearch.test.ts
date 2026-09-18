// GitHub's search syntax as the pane understands it. The query string is the
// only place a narrowing is written down, so these three things have to agree:
// what a query parses to, what it writes back out as, and which items survive
// it. Each is pinned here rather than by counting rows on a screen.

import { describe, it, expect } from 'bun:test'
import {
  DEFAULT_QUERY,
  filterItems,
  matchesSearch,
  parseSearch,
  setStateQualifier,
  stateFilterFor,
  stringifySearch,
  toggleQualifier,
  valuesOf
} from '../src/renderer/src/kernel/plugins/github/search'
import type { GithubIssueItem, GithubPullItem } from '../src/shared/types'

function issue(overrides: Partial<GithubIssueItem> = {}): GithubIssueItem {
  return {
    kind: 'issue',
    number: 42,
    title: 'Crash when opening a worktree',
    url: '',
    state: 'OPEN',
    author: 'Letsmoe',
    createdAt: '2026-09-18T10:00:00Z',
    updatedAt: '2026-09-18T10:00:00Z',
    commentCount: 0,
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
    additions: 1,
    deletions: 1,
    headRefName: 'fix/crash',
    baseRefName: 'main',
    reviewDecision: null,
    checks: null,
    ...overrides
  }
}

/** Does this item survive the query, with nobody signed in? */
function matches(item: GithubIssueItem | GithubPullItem, query: string): boolean {
  return matchesSearch(item, parseSearch(query), null)
}

describe('parseSearch', () => {
  it('splits qualifiers from the words left over', () => {
    const search = parseSearch('is:open label:bug crash on open')
    expect(search.qualifiers).toEqual([
      { key: 'is', value: 'open', negated: false },
      { key: 'label', value: 'bug', negated: false }
    ])
    expect(search.text).toBe('crash on open')
  })

  it('keeps a quoted value in one piece and drops the quotes', () => {
    expect(parseSearch('label:"good first issue"').qualifiers).toEqual([
      { key: 'label', value: 'good first issue', negated: false }
    ])
  })

  it('reads a leading dash as a negation', () => {
    expect(parseSearch('-label:wontfix').qualifiers).toEqual([
      { key: 'label', value: 'wontfix', negated: true }
    ])
  })

  it('treats an unknown key as words, not as a broken qualifier', () => {
    const search = parseSearch('mentions:ada https://example.com/x')
    expect(search.qualifiers).toEqual([])
    expect(search.text).toBe('mentions:ada https://example.com/x')
  })

  it('ignores a key with nothing after the colon, which is what typing looks like', () => {
    expect(parseSearch('label:').qualifiers).toEqual([])
  })

  it('lowercases the key but leaves the value as written', () => {
    expect(parseSearch('Label:Bug').qualifiers).toEqual([
      { key: 'label', value: 'Bug', negated: false }
    ])
  })
})

describe('stringifySearch', () => {
  it('round-trips a query through a parse', () => {
    const query = 'is:open -label:wontfix label:"good first issue" crash'
    expect(stringifySearch(parseSearch(query))).toBe(query)
  })

  it('quotes only what needs it', () => {
    expect(stringifySearch(parseSearch('milestone:"v1.0" label:bug'))).toBe(
      'milestone:v1.0 label:bug'
    )
  })
})

describe('toggleQualifier', () => {
  it('adds one that was not there', () => {
    expect(toggleQualifier('is:open', 'label', 'bug')).toBe('is:open label:bug')
  })

  it('takes out the one it just added', () => {
    expect(toggleQualifier('is:open label:bug', 'label', 'bug')).toBe('is:open')
  })

  it('matches regardless of case, because the query is typed by hand', () => {
    expect(toggleQualifier('label:Bug', 'label', 'bug')).toBe('')
  })

  it('leaves a negation of the same value alone', () => {
    expect(toggleQualifier('-label:bug', 'label', 'bug')).toBe('-label:bug label:bug')
  })

  it('quotes a value with spaces so it survives the next parse', () => {
    const query = toggleQualifier('', 'milestone', 'v1 beta')
    expect(query).toBe('milestone:"v1 beta"')
    expect(valuesOf(parseSearch(query), 'milestone')).toEqual(['v1 beta'])
  })

  it('keeps the free text', () => {
    expect(toggleQualifier('crash', 'author', 'ada')).toBe('author:ada crash')
  })
})

describe('setStateQualifier', () => {
  it('replaces the state without touching the rest', () => {
    expect(setStateQualifier('is:open label:bug', 'closed')).toBe('is:closed label:bug')
  })

  it('leaves the other things is: can ask alone', () => {
    expect(setStateQualifier('is:draft is:open', 'closed')).toBe('is:closed is:draft')
  })

  it('writes nothing at all for every state', () => {
    expect(setStateQualifier('is:open label:bug', 'all')).toBe('label:bug')
  })

  it('drops state: as well, so the two cannot disagree', () => {
    expect(setStateQualifier('state:closed', 'open')).toBe('is:open')
  })
})

describe('stateFilterFor', () => {
  it('reads the fetch off the query', () => {
    expect(stateFilterFor(parseSearch(DEFAULT_QUERY))).toBe('open')
    expect(stateFilterFor(parseSearch('is:closed'))).toBe('closed')
    expect(stateFilterFor(parseSearch('is:merged'))).toBe('closed')
  })

  it('covers everything when the query names no state', () => {
    expect(stateFilterFor(parseSearch('label:bug'))).toBe('all')
  })

  it('covers everything when it names states on both sides', () => {
    expect(stateFilterFor(parseSearch('is:open is:closed'))).toBe('all')
  })

  it('covers everything when a state is excluded rather than asked for', () => {
    expect(stateFilterFor(parseSearch('-is:open'))).toBe('all')
  })
})

describe('matchesSearch', () => {
  it('matches free text the way the box always did', () => {
    expect(matches(issue(), 'crash')).toBe(true)
    expect(matches(issue(), '#42')).toBe(true)
    expect(matches(issue(), 'unrelated')).toBe(false)
  })

  it('answers is: for both kinds', () => {
    expect(matches(issue(), 'is:open')).toBe(true)
    expect(matches(issue({ state: 'CLOSED' }), 'is:open')).toBe(false)
    expect(matches(pull({ state: 'MERGED' }), 'is:merged')).toBe(true)
    expect(matches(pull({ isDraft: true }), 'is:draft')).toBe(true)
    expect(matches(issue(), 'is:pr')).toBe(false)
    expect(matches(pull(), 'is:pr')).toBe(true)
  })

  it('counts a merged pull request as closed, as GitHub does', () => {
    expect(matches(pull({ state: 'MERGED' }), 'is:closed')).toBe(true)
  })

  it('narrows to all of several labels, but any of several authors', () => {
    const labelled = issue({
      labels: [
        { name: 'bug', color: '' },
        { name: 'area:terminal', color: '' }
      ]
    })
    expect(matches(labelled, 'label:bug label:area:terminal')).toBe(true)
    expect(matches(labelled, 'label:bug label:enhancement')).toBe(false)
    expect(matches(issue(), 'author:Letsmoe author:claude')).toBe(true)
  })

  it('combines different keys with and', () => {
    expect(matches(issue(), 'is:open author:Letsmoe')).toBe(true)
    expect(matches(issue(), 'is:open author:claude')).toBe(false)
  })

  it('excludes what a dash names', () => {
    expect(matches(issue(), '-label:bug')).toBe(false)
    expect(matches(issue(), '-label:wontfix')).toBe(true)
    expect(matches(pull({ isDraft: true }), '-is:draft')).toBe(false)
  })

  it('resolves @me against the signed-in user', () => {
    expect(matchesSearch(issue(), parseSearch('author:@me'), 'Letsmoe')).toBe(true)
    expect(matchesSearch(issue(), parseSearch('author:@me'), 'ada')).toBe(false)
    expect(matchesSearch(issue(), parseSearch('assignee:@me'), 'ada')).toBe(true)
  })

  it('answers no: for what an item is missing', () => {
    expect(matches(issue({ labels: [] }), 'no:label')).toBe(true)
    expect(matches(issue(), 'no:label')).toBe(false)
    expect(matches(issue({ assignees: [] }), 'no:assignee')).toBe(true)
    expect(matches(issue(), 'no:milestone')).toBe(true)
  })

  it('matches milestone, type and project by name', () => {
    const tracked = issue({
      milestone: { number: 1, title: 'v1.0', state: 'open', dueOn: null },
      issueType: { name: 'Bug', color: 'RED' },
      projects: [{ number: 2, title: 'Roadmap', url: '' }]
    })
    expect(matches(tracked, 'milestone:v1.0')).toBe(true)
    expect(matches(tracked, 'type:bug')).toBe(true)
    expect(matches(tracked, 'project:Roadmap')).toBe(true)
    expect(matches(tracked, 'milestone:v2.0 milestone:v1.0')).toBe(true)
  })

  it('does not match metadata the query was never allowed to ask for', () => {
    expect(matches(issue(), 'project:Roadmap')).toBe(false)
  })

  it('matches a pull request by branch, and no issue ever', () => {
    expect(matches(pull(), 'head:fix/crash')).toBe(true)
    expect(matches(pull(), 'base:main')).toBe(true)
    expect(matches(issue(), 'base:main')).toBe(false)
  })

  // Half-typed qualifiers are the common case while someone is still typing,
  // and blanking the list under them says nothing about what went wrong.
  it('ignores a word it does not know rather than hiding everything', () => {
    expect(matches(issue(), 'is:banana')).toBe(true)
    expect(matches(issue(), 'no:banana')).toBe(true)
  })
})

describe('filterItems', () => {
  it('keeps the incoming order', () => {
    const items = [issue({ number: 1 }), issue({ number: 2, title: 'Other' }), issue({ number: 3 })]
    expect(filterItems(items, parseSearch('crash'), null).map((item) => item.number)).toEqual([
      1, 3
    ])
  })
})
