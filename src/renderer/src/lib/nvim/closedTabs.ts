// Grove's tab list and nvim's buffer list drift apart unless every close is
// mirrored into nvim: a buffer left behind is what nvim falls back to when the
// current one goes, and the buffer-state snapshot then re-adds its tab.

/** Paths present in the previous tab list and missing from the current one. */
export function closedTabPaths(previous: readonly string[], current: readonly string[]): string[] {
  const stillOpen = new Set(current)
  return previous.filter((path) => !stillOpen.has(path))
}
