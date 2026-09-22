// How a diff tab rebuilds its diff when it is shown again. Neovim's diff is a
// window beside the tab's buffer, not part of the buffer: leaving the tab
// closes that window (or leaves it beside some other file), so coming back
// would show one side alone. Whatever opened the diff registers how to put the
// other side back, and the editor pane calls it each time it shows the tab.

import { store } from '../store.svelte'

type Restore = (nvimId: string) => Promise<void>

const restorers = new Map<string, Restore>()

/** Remembers how to rebuild the diff for the tab at this path. */
export function registerDiffRestore(path: string, restore: Restore): void {
  restorers.set(path, restore)
}

/**
 * Rebuilds the tab's diff, if it was opened as one and still is. A tab since
 * opened plainly, or closed, has lost its diff label and is forgotten here.
 */
export async function restoreDiff(nvimId: string, path: string): Promise<void> {
  const restore = restorers.get(path)
  if (!restore) return
  if (!isDiffTab(path)) {
    restorers.delete(path)
    return
  }
  await restore(nvimId)
}

/** Whether an open tab at this path is labelled as a diff. */
function isDiffTab(path: string): boolean {
  return store.tabs.some((tab) => tab.path === path && tab.diff !== undefined)
}
