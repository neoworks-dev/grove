// Whether a resolved pull request can be pushed back, which decides whether the
// GitHub pane offers the push at all. Pushing to the wrong place is worse than
// not offering it, and a fork is where that goes wrong.

import { describe, expect, test } from 'bun:test'
import { decidePushTarget } from '../src/main/githubDashboard'

const FORK = {
  url: 'https://github.com/contributor/grove',
  nameWithOwner: 'contributor/grove',
  viewerPermission: 'READ'
}

const OWN = {
  url: 'https://github.com/neoworks-dev/grove',
  nameWithOwner: 'neoworks-dev/grove',
  viewerPermission: 'WRITE'
}

describe('decidePushTarget', () => {
  test('a branch on a repository the viewer can write to is pushable', () => {
    const decision = decidePushTarget('WRITE', {
      headRefName: '92-conflict-hunks',
      maintainerCanModify: false,
      headRepository: OWN
    })

    expect(decision.blockedReason).toBeNull()
    expect(decision.target).toEqual({
      repository: 'neoworks-dev/grove',
      branch: '92-conflict-hunks',
      url: 'https://github.com/neoworks-dev/grove'
    })
  })

  test('a fork that allows maintainer edits is pushable by a maintainer', () => {
    const decision = decidePushTarget('MAINTAIN', {
      headRefName: 'patch-1',
      maintainerCanModify: true,
      headRepository: FORK
    })

    expect(decision.blockedReason).toBeNull()
    expect(decision.target?.url).toBe('https://github.com/contributor/grove')
  })

  test('the same fork is not pushable without write access to the base', () => {
    const decision = decidePushTarget('READ', {
      headRefName: 'patch-1',
      maintainerCanModify: true,
      headRepository: FORK
    })

    expect(decision.target).toBeNull()
    expect(decision.blockedReason).toBe('no write access to contributor/grove')
  })

  test('a fork that refuses maintainer edits says so', () => {
    const decision = decidePushTarget('ADMIN', {
      headRefName: 'patch-1',
      maintainerCanModify: false,
      headRepository: FORK
    })

    expect(decision.target).toBeNull()
    expect(decision.blockedReason).toBe('contributor/grove does not allow edits from maintainers')
  })

  test('a deleted fork has nowhere to push to', () => {
    const decision = decidePushTarget('ADMIN', {
      headRefName: 'patch-1',
      maintainerCanModify: true,
      headRepository: null
    })

    expect(decision.target).toBeNull()
    expect(decision.blockedReason).toBe('the branch this was opened from is gone')
  })
})
