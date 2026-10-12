// Launchpad's grouping: which group each pull request and issue lands in, and
// the order the groups come in.

import { describe, it, expect } from 'bun:test'
import {
  issueGroupOf,
  launchpadGroups,
  pinKey,
  pullGroupOf
} from '../src/renderer/src/kernel/plugins/git/github/launchpad'
import type { GithubIssueItem, GithubPullItem } from '../src/shared/types'

const VIEWER = 'moritz'

function issue(overrides: Partial<GithubIssueItem> = {}): GithubIssueItem {
  return {
    kind: 'issue',
    number: 42,
    title: 'Crash when opening a worktree',
    url: 'https://github.com/acme/grove/issues/42',
    state: 'OPEN',
    author: 'ada',
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z',
    commentCount: 0,
    labels: [],
    assignees: [],
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
    reviewRequested: [],
    checks: 'SUCCESS',
    ...overrides
  }
}

describe('pullGroupOf', () => {
  it('puts a pull request asking the viewer for a review first, whatever its checks', () => {
    const asking = pull({ reviewRequested: [VIEWER], checks: 'FAILURE' })
    expect(pullGroupOf(asking, VIEWER)).toBe('needs-your-review')
  })

  it('files failing checks before a review verdict', () => {
    const failing = pull({ checks: 'FAILURE', reviewDecision: 'CHANGES_REQUESTED' })
    expect(pullGroupOf(failing, VIEWER)).toBe('ci-failing')
    expect(pullGroupOf(pull({ checks: 'ERROR' }), VIEWER)).toBe('ci-failing')
  })

  it('separates changes requested, ready to merge and waiting', () => {
    expect(pullGroupOf(pull({ reviewDecision: 'CHANGES_REQUESTED' }), VIEWER)).toBe(
      'changes-requested'
    )
    expect(pullGroupOf(pull({ reviewDecision: 'APPROVED' }), VIEWER)).toBe('ready-to-merge')
    expect(pullGroupOf(pull({ checks: null }), VIEWER)).toBe('ready-to-merge')
    expect(pullGroupOf(pull({ reviewDecision: 'REVIEW_REQUIRED' }), VIEWER)).toBe(
      'waiting-on-others'
    )
    expect(pullGroupOf(pull({ checks: 'PENDING' }), VIEWER)).toBe('waiting-on-others')
  })

  it('keeps drafts, merged and closed pull requests apart from the open ones', () => {
    expect(pullGroupOf(pull({ isDraft: true, reviewRequested: [VIEWER] }), VIEWER)).toBe('draft')
    expect(pullGroupOf(pull({ state: 'MERGED' }), VIEWER)).toBe('merged')
    expect(pullGroupOf(pull({ state: 'CLOSED' }), VIEWER)).toBe('closed-pulls')
  })

  it('reads a snapshot saved before review requests were fetched', () => {
    expect(pullGroupOf(pull({ reviewRequested: undefined }), VIEWER)).toBe('ready-to-merge')
  })
})

describe('issueGroupOf', () => {
  it('groups issues by who has them', () => {
    const me = { login: VIEWER, avatarUrl: null }
    const someone = { login: 'ada', avatarUrl: null }
    expect(issueGroupOf(issue({ assignees: [someone, me] }), VIEWER)).toBe('assigned-to-you')
    expect(issueGroupOf(issue(), VIEWER)).toBe('unassigned')
    expect(issueGroupOf(issue({ assignees: [someone] }), VIEWER)).toBe('assigned-to-others')
    expect(issueGroupOf(issue({ state: 'CLOSED', assignees: [me] }), VIEWER)).toBe(
      'closed-issues'
    )
  })
})

describe('launchpadGroups', () => {
  it('orders pinned, then pull requests, then issues, and leaves empty groups out', () => {
    const items = [
      issue({ number: 1 }),
      pull({ number: 2, reviewDecision: 'APPROVED' }),
      issue({ number: 3, assignees: [{ login: VIEWER, avatarUrl: null }] }),
      pull({ number: 4, checks: 'FAILURE' })
    ]
    const groups = launchpadGroups(items, VIEWER, new Set())
    expect(groups.map((group) => group.id)).toEqual([
      'ci-failing',
      'ready-to-merge',
      'assigned-to-you',
      'unassigned'
    ])
  })

  it('shows a pinned item under Pinned and in its own group too', () => {
    const approved = pull({ number: 2, reviewDecision: 'APPROVED' })
    const pinnedOnGithub = issue({ number: 5, isPinned: true })
    const groups = launchpadGroups([approved, pinnedOnGithub], VIEWER, new Set([pinKey(approved)]))
    expect(groups[0].id).toBe('pinned')
    expect(groups[0].items.map((item) => item.number)).toEqual([2, 5])
    expect(groups.map((group) => group.id)).toEqual(['pinned', 'ready-to-merge', 'unassigned'])
  })
})
