// The GitHub dashboard service builds two things before it shells out: the
// GraphQL document behind a refresh, and the argv of a write action. Both are
// pure and both decide what GitHub is actually asked to do, so they are pinned
// here (the network calls themselves are not exercised).

import { describe, it, expect } from 'bun:test'
import {
  createIssueArgs,
  dashboardQuery,
  itemActionArgs,
  itemDetailQuery,
  milestoneChangeArgs,
  optionalFields,
  relationshipFields,
  scopeHint
} from '../src/main/githubDashboard'

// What a token with nothing extra granted can ask for, which is the case the
// optional selections exist to protect.
const PLAIN = { projects: false, issueTypes: false, subIssues: false, linkedBranches: false }
const FULL = { projects: true, issueTypes: true, subIssues: true, linkedBranches: true }

describe('dashboardQuery', () => {
  it('asks for open items only under the open filter', () => {
    const query = dashboardQuery('open', PLAIN)
    expect(query).toContain('issues(first: $limit, states: [OPEN]')
    expect(query).toContain('pullRequests(first: $limit, states: [OPEN]')
  })

  it('counts merged pull requests as closed', () => {
    const query = dashboardQuery('closed', PLAIN)
    expect(query).toContain('issues(first: $limit, states: [CLOSED]')
    expect(query).toContain('pullRequests(first: $limit, states: [CLOSED, MERGED]')
  })

  it('covers every state under the all filter', () => {
    const query = dashboardQuery('all', PLAIN)
    expect(query).toContain('states: [OPEN, CLOSED]')
    expect(query).toContain('states: [OPEN, CLOSED, MERGED]')
  })

  it('fetches both sides and the viewer in one request', () => {
    const query = dashboardQuery('open', PLAIN)
    expect(query).toContain('viewer { login }')
    expect(query.match(/nodes \{/g)?.length).toBeGreaterThan(1)
  })
})

describe('optionalFields', () => {
  it('always asks for the milestone, which needs no scope', () => {
    expect(optionalFields(PLAIN, true)).toContain('milestone {')
  })

  it('leaves out what the token was not granted', () => {
    const fields = optionalFields(PLAIN, true)
    expect(fields).not.toContain('projectItems')
    expect(fields).not.toContain('issueType')
  })

  it('asks for projects and types once they are available', () => {
    const fields = optionalFields(FULL, true)
    expect(fields).toContain('projectItems(first: 10)')
    expect(fields).toContain('issueType { name color }')
  })

  it('never asks a pull request for an issue type', () => {
    expect(optionalFields(FULL, false)).not.toContain('issueType')
  })
})

describe('itemDetailQuery', () => {
  it('keeps projects out of both branches without the scope', () => {
    expect(itemDetailQuery(PLAIN)).not.toContain('projectItems')
  })

  it('asks both branches for projects once the scope is there', () => {
    expect(itemDetailQuery(FULL).match(/projectItems/g)?.length).toBe(2)
  })
})

describe('relationshipFields', () => {
  it('asks for nothing when the schema has neither', () => {
    expect(relationshipFields(PLAIN)).toBe('')
  })

  it('takes the parent and the children together', () => {
    const fields = relationshipFields({ ...PLAIN, subIssues: true })
    expect(fields).toContain('parent { number title state url }')
    expect(fields).toContain('subIssuesSummary')
    expect(fields).not.toContain('linkedBranches')
  })

  it('asks for linked branches on their own probe', () => {
    const fields = relationshipFields({ ...PLAIN, linkedBranches: true })
    expect(fields).toContain('linkedBranches(first: 10)')
    expect(fields).not.toContain('subIssues')
  })
})

describe('itemDetailQuery relationships', () => {
  it('keeps them out of the pull-request branch, which has no parent', () => {
    expect(itemDetailQuery(FULL).match(/subIssuesSummary/g)?.length).toBe(1)
  })
})

describe('scopeHint', () => {
  it('replaces a scope wall with the command that fixes it', () => {
    const raw = new Error(
      'gh api graphql failed: {"errors":[{"type":"INSUFFICIENT_SCOPES","message":"The \'updateSubscription\' field requires one of the following scopes: [\'notifications\'], but your token has only been granted the: [\'repo\'] scopes."}]}'
    )
    const hinted = scopeHint(raw, 'notifications', 'change what it watches')
    expect(hinted.message).toBe(
      'Your GitHub token cannot change what it watches. Run: gh auth refresh -s notifications'
    )
  })

  it('leaves a real failure alone', () => {
    const raw = new Error('gh issue close failed: could not resolve to an Issue')
    expect(scopeHint(raw, 'notifications', 'x')).toBe(raw)
  })
})

describe('milestoneChangeArgs', () => {
  it('sets a milestone by title', () => {
    expect(milestoneChangeArgs('issue', 12, 'v1.0')).toEqual([
      'issue',
      'edit',
      '12',
      '--milestone',
      'v1.0'
    ])
  })

  it('clears it with its own flag rather than an empty title', () => {
    expect(milestoneChangeArgs('pull', 7, null)).toEqual(['pr', 'edit', '7', '--remove-milestone'])
  })
})

describe('itemActionArgs', () => {
  it('closes and reopens issues', () => {
    expect(itemActionArgs('issue', 12, 'close')).toEqual(['issue', 'close', '12'])
    expect(itemActionArgs('issue', 12, 'reopen')).toEqual(['issue', 'reopen', '12'])
  })

  it('rejects pull-request-only actions on an issue', () => {
    expect(() => itemActionArgs('issue', 12, 'ready')).toThrow(/close and reopen/)
    expect(() => itemActionArgs('issue', 12, 'merge')).toThrow(/close and reopen/)
  })

  it('marks a pull request ready for review', () => {
    expect(itemActionArgs('pull', 7, 'ready')).toEqual(['pr', 'ready', '7'])
  })

  it('passes the merge method through, and the branch deletion when asked', () => {
    expect(itemActionArgs('pull', 7, 'merge', { method: 'squash', deleteBranch: false })).toEqual([
      'pr',
      'merge',
      '7',
      '--squash'
    ])
    expect(itemActionArgs('pull', 7, 'merge', { method: 'rebase', deleteBranch: true })).toEqual([
      'pr',
      'merge',
      '7',
      '--rebase',
      '--delete-branch'
    ])
  })

  it('refuses to merge without a method', () => {
    expect(() => itemActionArgs('pull', 7, 'merge')).toThrow(/merge method/)
  })
})

describe('createIssueArgs', () => {
  it('sends the body over stdin rather than the command line', () => {
    const args = createIssueArgs({ title: 'Terminal takes no mouse input', body: 'x', labels: [] })
    expect(args).toEqual([
      'issue',
      'create',
      '--title',
      'Terminal takes no mouse input',
      '--body-file',
      '-'
    ])
  })

  it('repeats --label once per label', () => {
    const args = createIssueArgs({ title: 'T', body: '', labels: ['bug', 'area:terminal'] })
    expect(args.slice(-4)).toEqual(['--label', 'bug', '--label', 'area:terminal'])
  })

  it('trims the title and refuses an empty one', () => {
    expect(createIssueArgs({ title: '  T  ', body: '', labels: [] })[3]).toBe('T')
    expect(() => createIssueArgs({ title: '   ', body: '', labels: [] })).toThrow(/needs a title/)
  })
})
