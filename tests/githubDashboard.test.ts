// The GitHub dashboard service builds two things before it shells out: the
// GraphQL document behind a refresh, and the argv of a write action. Both are
// pure and both decide what GitHub is actually asked to do, so they are pinned
// here (the network calls themselves are not exercised).

import { describe, it, expect } from 'bun:test'
import { createIssueArgs, dashboardQuery, itemActionArgs } from '../src/main/githubDashboard'

describe('dashboardQuery', () => {
  it('asks for open items only under the open filter', () => {
    const query = dashboardQuery('open')
    expect(query).toContain('issues(first: $limit, states: [OPEN]')
    expect(query).toContain('pullRequests(first: $limit, states: [OPEN]')
  })

  it('counts merged pull requests as closed', () => {
    const query = dashboardQuery('closed')
    expect(query).toContain('issues(first: $limit, states: [CLOSED]')
    expect(query).toContain('pullRequests(first: $limit, states: [CLOSED, MERGED]')
  })

  it('covers every state under the all filter', () => {
    const query = dashboardQuery('all')
    expect(query).toContain('states: [OPEN, CLOSED]')
    expect(query).toContain('states: [OPEN, CLOSED, MERGED]')
  })

  it('fetches both sides and the viewer in one request', () => {
    const query = dashboardQuery('open')
    expect(query).toContain('viewer { login }')
    expect(query.match(/nodes \{/g)?.length).toBeGreaterThan(1)
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
