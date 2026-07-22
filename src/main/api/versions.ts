// Optimistic-concurrency vocabulary for mutation routes. Versions themselves
// are domain semantics (git: a per-worktree generation counter; editor: the
// bridged nvim changedtick) — this module only standardizes the shape:
// mutations take an optional expectedVersion, reads return version, and a
// mismatch surfaces as a 'stale' result or a 'conflict' error.

export class VersionCounter {
  private counters = new Map<string, number>()

  current(key: string): number {
    return this.counters.get(key) ?? 1
  }

  bump(key: string): number {
    const next = this.current(key) + 1
    this.counters.set(key, next)
    return next
  }
}

// True when the caller supplied the version it read and the state has moved.
export function isStale(current: number, expected: number | undefined): boolean {
  if (expected === undefined) return false
  return expected !== current
}
