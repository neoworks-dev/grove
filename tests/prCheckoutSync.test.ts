// When a pull request's checkout may be fast-forwarded to the pull request, and
// what it says when it may not. Only a fast-forward is ever done for the user.

import { describe, it, expect } from 'bun:test'
import { updateBlockedReason } from '../src/main/prCheckoutSync'

const clean = { ahead: 0, behind: 0, dirty: false, mergeInProgress: false }

describe('updateBlockedReason', () => {
  it('has nothing to say when the checkout is not behind', () => {
    expect(updateBlockedReason(clean)).toBeNull()
    expect(updateBlockedReason({ ...clean, ahead: 2, dirty: true })).toBeNull()
  })

  it('lets a clean checkout with nothing of its own fast-forward', () => {
    expect(updateBlockedReason({ ...clean, behind: 3 })).toBeNull()
  })

  it('leaves a checkout with commits of its own alone, force-push or not', () => {
    const reason = updateBlockedReason({ ...clean, behind: 3, ahead: 1 })
    expect(reason).toContain('1 commit the pull request does not')
  })

  it('leaves uncommitted changes and open merges alone', () => {
    expect(updateBlockedReason({ ...clean, behind: 1, dirty: true })).toBe(
      'it has uncommitted changes'
    )
    expect(updateBlockedReason({ ...clean, behind: 1, mergeInProgress: true })).toBe(
      'a merge is open in it'
    )
  })
})
