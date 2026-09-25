// The editor tab strip's entries once nvim splits come in. Files on screen in
// the current tab page's splits read as one tab, `a.ts | b.ts | c.ts`, in
// nvim's window order; every other file keeps a tab of its own. Kept free of
// the DOM so the grouping can be tested on its own.

/** A file window in nvim's current tab page, as the buffer-state snapshot reports it. */
export interface SplitWindow {
  win: number
  path: string
}

/** The part of a tab the strip needs to place it. */
export interface StripTab {
  path: string
  name: string
}

/** One window of a split tab, with the tab its file has, or a stand-in for one it lacks yet. */
export interface SplitSegment<Tab extends StripTab> {
  win: number
  tab: Tab
}

export type StripEntry<Tab extends StripTab> =
  | { kind: 'tab'; key: string; tab: Tab }
  | { kind: 'splits'; key: string; segments: SplitSegment<Tab>[] }

/** A file's name as the tab shows it: the last path component. */
function fileName(path: string): string {
  const name = path.split(/[\\/]/).pop()
  if (name === undefined || name === '') return path
  return name
}

/** The tab for `path`, or a bare one when Grove has not attached the file yet. */
function tabFor<Tab extends StripTab>(path: string, tabs: Tab[]): Tab {
  const found = tabs.find((tab) => tab.path === path)
  if (found !== undefined) return found
  return { path, name: fileName(path) } as Tab
}

/**
 * The strip's entries in order. With two or more split windows showing files,
 * their tabs fold into one split tab where the first of them stood; with fewer,
 * the strip is the tabs as they are.
 */
export function stripEntries<Tab extends StripTab>(
  tabs: Tab[],
  splits: SplitWindow[]
): StripEntry<Tab>[] {
  const plain = tabs.map((tab): StripEntry<Tab> => ({ kind: 'tab', key: tab.path, tab }))
  if (splits.length < 2) return plain

  const splitPaths = new Set(splits.map((split) => split.path))
  const group: StripEntry<Tab> = {
    kind: 'splits',
    key: `splits:${splits.map((split) => split.win).join(',')}`,
    segments: splits.map((split) => ({ win: split.win, tab: tabFor(split.path, tabs) }))
  }
  const entries: StripEntry<Tab>[] = []
  for (const entry of plain) {
    if (entry.kind === 'tab' && splitPaths.has(entry.tab.path)) {
      if (!entries.includes(group)) entries.push(group)
      continue
    }
    entries.push(entry)
  }
  if (!entries.includes(group)) entries.push(group)
  return entries
}
