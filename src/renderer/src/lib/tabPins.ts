// Pinned tabs across restarts. Open tabs persist as bare paths per worktree,
// so the pins persist beside them as a second path list and are laid back
// onto the restored tabs. Pure, so the round trip is testable without runes.

interface PinnableTab {
  path: string
  pinned?: boolean
  scratch?: boolean
}

/** The pinned file tabs of each worktree, as paths; scratch buffers never persist. */
export function pinnedPathsByWorktree(
  tabsByWorktree: Record<string, PinnableTab[]>
): Record<string, string[]> {
  const pinned: Record<string, string[]> = {}
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const paths = tabs.filter((tab) => tab.pinned && !tab.scratch).map((tab) => tab.path)
    if (paths.length > 0) {
      pinned[worktreeId] = paths
    }
  }
  return pinned
}

/** Marks the tabs whose paths were persisted as pinned. */
export function applyPins<Tab extends PinnableTab>(
  tabs: Tab[],
  pinnedPaths: string[] | undefined
): Tab[] {
  if (!pinnedPaths || pinnedPaths.length === 0) {
    return tabs
  }
  const pinned = new Set(pinnedPaths)
  return tabs.map((tab) => {
    if (!pinned.has(tab.path)) {
      return tab
    }
    return { ...tab, pinned: true }
  })
}
