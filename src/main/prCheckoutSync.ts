// Whether a pull request's `pr-<n>` checkout can follow the pull request. Only a
// fast-forward is ever done for the user: anything else would throw away work
// that is on the checkout — local commits, uncommitted changes, or the old head
// a force-push left behind — so it is reported and left for them to decide.

/** Where a checkout stands against the pull request's fetched head. */
export interface CheckoutPosition {
  /** Commits the checkout has that the pull request's head does not. */
  ahead: number
  /** Commits the pull request's head has that the checkout does not. */
  behind: number
  dirty: boolean
  mergeInProgress: boolean
}

/**
 * Why a checkout that is behind cannot simply be fast-forwarded, or null when
 * it can — or when it is not behind at all and there is nothing to do.
 */
export function updateBlockedReason(position: CheckoutPosition): string | null {
  if (position.behind === 0) return null
  if (position.mergeInProgress) return 'a merge is open in it'
  if (position.ahead > 0) {
    return `it has ${position.ahead} commit${plural(position.ahead)} the pull request does not — local work, or what a force-push replaced`
  }
  if (position.dirty) return 'it has uncommitted changes'
  return null
}

/** The plural suffix for a count. */
function plural(count: number): string {
  if (count === 1) return ''
  return 's'
}
