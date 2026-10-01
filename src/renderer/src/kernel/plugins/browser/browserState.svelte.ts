// What the Browser pane remembers per worktree: the address it was last on, and
// what an agent is doing in it right now.

import type { BrowserActivity, ServiceRuntime } from '../../../../../shared/types'

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
    if (this.activity[activity.worktreeId] !== activity) return
    const next = { ...this.activity }
    delete next[activity.worktreeId]
    this.activity = next
  }
}

export const browserState = new BrowserState()

/**
 * Where a worktree's preview starts: where it was last, else its dev server —
 * a running service's preview address before a stopped one's. Empty when
 * there is neither.
 */
export function startingUrl(remembered: string | undefined, services: readonly ServiceRuntime[]): string {
  if (remembered) return remembered
  const withPreview = services.filter((service) => service.previewUrl)
  const running = withPreview.find((service) => service.status === 'running')
  if (running && running.previewUrl) return running.previewUrl
  if (withPreview.length > 0 && withPreview[0].previewUrl) return withPreview[0].previewUrl
  return ''
}

/**
 * What the address bar's text means as an address: as typed when it has a
 * scheme, else http for a local host and https for anything else.
 */
export function addressOf(typed: string): string {
  const text = typed.trim()
  if (text.length === 0) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^localhost:\d/i.test(text)) return text
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (/^:\d+/.test(text)) return `http://localhost${text}`
  return `https://${text}`
}

/** How a picked element reads in the composer, for the agent to find it again. */
export function describePickedElement(element: { selector: string; name: string; url: string }): string {
  let text = `the element \`${element.selector}\``
  if (element.name) text += ` (“${element.name}”)`
  return `${text} in the browser preview at ${element.url} `
}
