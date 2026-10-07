// The File › Recent Projects list as a pure transform, kept apart from state.ts
// (which needs Electron) so it can be tested on its own.

// How many repositories File › Recent Projects remembers.
const RECENT_REPO_LIMIT = 10

/** The recent list with repoPath moved to the front, deduplicated and capped. */
export function withRecent(recentRepoPaths: string[], repoPath: string): string[] {
  const others = recentRepoPaths.filter((path) => path !== repoPath)
  return [repoPath, ...others].slice(0, RECENT_REPO_LIMIT)
}
