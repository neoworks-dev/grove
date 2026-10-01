// What the Browser pane remembers per worktree: the address it was last on, and
// what an agent is doing in it right now.

import type { BrowserActivity } from '../../../../../shared/types'

// How long an agent's action stays on the pane's activity line.
const ACTIVITY_SHOWN_MS = 4000

class BrowserState {
  /** The address each worktree's preview was last on. */
  urls = $state<Record<string, string>>({})
  /** The latest thing an agent did in each worktree's preview, while it is fresh. */
  activity = $state<Record<string, BrowserActivity>>({})

  private clearTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Remembers where a worktree's preview is. */
  remember(worktreeId: string, url: string): void {
    if (this.urls[worktreeId] === url) return
    this.urls = { ...this.urls, [worktreeId]: url }
  }

  /** Shows what an agent is doing, for a few seconds. */
  noteActivity(activity: BrowserActivity): void {
    this.activity = { ...this.activity, [activity.worktreeId]: activity }
    const pending = this.clearTimers.get(activity.worktreeId)
    if (pending) clearTimeout(pending)
    this.clearTimers.set(
      activity.worktreeId,
      setTimeout(() => this.clearActivity(activity), ACTIVITY_SHOWN_MS)
    )
  }

  /** Drops an activity once it is stale, unless a newer one replaced it. */
  private clearActivity(activity: BrowserActivity): void {
    // Compared by time: what the state holds is a proxy of the activity, never the object itself.
    const shown = this.activity[activity.worktreeId]
    if (!shown || shown.at !== activity.at || shown.text !== activity.text) return
    const next = { ...this.activity }
    delete next[activity.worktreeId]
    this.activity = next
  }
}

export const browserState = new BrowserState()
