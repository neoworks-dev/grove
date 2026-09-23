// The prompt an agent starts on when it is handed an issue: the issue and its
// thread, and nothing the repository's own instructions already say.

import { describe, it, expect } from 'bun:test'
import { issuePrompt } from '../src/renderer/src/kernel/plugins/github/issuePrompt'
import type { GithubItemDetail } from '../src/shared/types'

/** A detail with only what the prompt reads filled in. */
function issue(overrides: Partial<GithubItemDetail>): GithubItemDetail {
  return {
    number: 60,
    title: 'No way to hand an issue to an agent',
    url: 'https://github.com/neoworks-dev/grove/issues/60',
    labels: [],
    body: 'The body.',
    timeline: [],
    ...overrides
  } as GithubItemDetail
}

/** A comment entry as the timeline carries it. */
function comment(login: string, body: string): GithubItemDetail['timeline'][number] {
  return {
    type: 'comment',
    at: '2026-09-01T10:00:00Z',
    comment: {
      id: login,
      author: { login, avatarUrl: null },
      body,
      createdAt: '2026-09-01T10:00:00Z',
      url: '',
      authorAssociation: 'OWNER'
    }
  }
}

describe('issuePrompt', () => {
  it('leads with the number, title and link, then the body', () => {
    const prompt = issuePrompt(issue({}))
    expect(prompt.startsWith('Issue #60: No way to hand an issue to an agent')).toBe(true)
    expect(prompt).toContain('https://github.com/neoworks-dev/grove/issues/60')
    expect(prompt).toContain('The body.')
  })

  it('lists the labels by name', () => {
    const prompt = issuePrompt(
      issue({
        labels: [
          { name: 'enhancement', color: '' },
          { name: 'area:agents', color: '' }
        ]
      })
    )
    expect(prompt).toContain('Labels: enhancement, area:agents')
  })

  it('carries the comment thread in order, attributed', () => {
    const prompt = issuePrompt(
      issue({ timeline: [comment('alice', 'First.'), comment('bob', 'Second.')] })
    )
    expect(prompt).toContain('## Comments')
    expect(prompt.indexOf('**@alice** (2026-09-01):\nFirst.')).toBeLessThan(
      prompt.indexOf('**@bob** (2026-09-01):\nSecond.')
    )
  })

  it('says so when there is no description, and has no comments section without comments', () => {
    const prompt = issuePrompt(issue({ body: '  ' }))
    expect(prompt).toContain('(No description.)')
    expect(prompt).not.toContain('## Comments')
  })
})
