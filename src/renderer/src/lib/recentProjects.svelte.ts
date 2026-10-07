// File › Recent Projects. Main owns the list (it records every repository it
// opens) and pushes it on `event:recent-repos`; this module mirrors it into
// menu items. Each push replaces the whole section, so stale entries never
// linger.

import { menu, type MenuItem } from './menu.svelte'
import { store, openRepoResult } from './store.svelte'

const RECENT_GROUP = '2-recent'

/** Mirror main's recent-repository list into the File menu; returns the inverse. */
export function registerRecentProjects(): () => void {
  let disposeItems = (): void => {}
  let disposed = false

  /** Replaces the menu section with one item per recent repository. */
  function apply(paths: string[]): void {
    if (disposed) {
      return
    }
    disposeItems()
    disposeItems = menu.registerItems(recentItems(paths))
  }

  const stopEvents = window.workbench.on('event:recent-repos', (payload) => apply(payload as string[]))
  void window.workbench.repo.recent().then(apply)

  return () => {
    disposed = true
    stopEvents()
    disposeItems()
  }
}

/** The menu items for a recent list: one per repository, then a clear action. */
function recentItems(paths: string[]): MenuItem[] {
  if (paths.length === 0) {
    return []
  }
  const items: MenuItem[] = paths.map((repoPath, index) => ({
    id: `file.recent.${repoPath}`,
    menuId: 'file',
    label: repoName(repoPath),
    detail: repoPath,
    group: RECENT_GROUP,
    groupLabel: 'Recent Projects',
    order: index,
    // Reopening the repository that is already open would only reload it.
    when: () => store.repo?.path !== repoPath,
    run: () => openRecent(repoPath)
  }))
  items.push({
    id: 'file.recent.clear',
    menuId: 'file',
    label: 'Clear Recent Projects',
    group: RECENT_GROUP,
    order: paths.length,
    // Only when some other repository is listed; the open one is hidden above.
    when: () => paths.some((repoPath) => store.repo?.path !== repoPath),
    run: () => window.workbench.repo.clearRecent()
  })
  return items
}

/** The directory name a repository is shown under. */
function repoName(repoPath: string): string {
  const name = repoPath.split('/').pop()
  if (!name) {
    return repoPath
  }
  return name
}

/** Opens a recent repository, surfacing failures (e.g. a moved folder) in the shell. */
async function openRecent(repoPath: string): Promise<void> {
  store.clearError()
  try {
    const result = await window.workbench.repo.open(repoPath)
    await openRepoResult(result)
  } catch (error) {
    store.setError((error as Error).message)
  }
}
