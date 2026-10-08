// The last list the GitHub pane loaded for a repository, kept across restarts
// so the pane opens on it at once and refreshes behind it, rather than empty
// for the seconds a first fetch takes.

import type { GithubDashboard } from '../../../../../shared/types'

const KEY_PREFIX = 'grove.github.dashboard:'

/** Remembers a repository's dashboard; a full or unavailable storage only costs the head start. */
export function saveDashboardSnapshot(repoPath: string, dashboard: GithubDashboard): void {
  try {
    localStorage.setItem(KEY_PREFIX + repoPath, JSON.stringify(dashboard))
  } catch {
    // Quota or private mode: the next open just waits for the fetch.
  }
}

/** The dashboard last saved for a repository, or null when there is none or it cannot be read. */
export function loadDashboardSnapshot(repoPath: string): GithubDashboard | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY_PREFIX + repoPath)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    return JSON.parse(raw) as GithubDashboard
  } catch {
    return null
  }
}
