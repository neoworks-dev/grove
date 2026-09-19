// The shape of what `qa probe` reads out of a running app: the layout tree, what
// each pane holds, and the session's own account of itself.
//
// Types only, and no imports — `drive.ts` runs under node and `tree.ts` under
// bun, and this is the one thing both of them need to agree on.

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** An element as `probe` reports it: what to call it, and where it is. */
export interface ProbeElement {
  ref: string
  role: string
  name: string
  at: string
  size: string
  disabled?: boolean
}

/** A pane of the layout tree, as the renderer's layout store describes it. */
export interface PaneSummary {
  kind: 'leaf'
  id: string
  paneTypeId: string
  title: string
  focused: boolean
  // Absent unless notable: an unregistered type (its plugin has not loaded), a
  // slot family, a pane holding its own pixel width, state it was opened with.
  registered?: boolean
  slot?: string
  sizePx?: number
  paneState?: Record<string, unknown>
}

export interface SplitSummary {
  kind: 'split'
  id: string
  direction: 'row' | 'column'
  sizes: number[]
  children: LayoutSummary[]
}

export type LayoutSummary = PaneSummary | SplitSummary

/** The same tree, once the driver has put each pane's elements back on it. */
export type TreeNode =
  | (PaneSummary & { width: number; height: number; elements: ProbeElement[] })
  | (Omit<SplitSummary, 'children'> & { children: TreeNode[] })

/** What the renderer reports about itself, tree not yet joined to the DOM. */
export interface RendererState {
  window: { width: number; height: number }
  view: { id: string; label: string } | null
  worktree: string | null
  activeTab: string | null
  activePane: string | null
  activeLeafId: string | null
  tree: LayoutSummary | null
  leafBoxes: Record<string, Box>
  // Only the gutters actually rendered; a tree node is not proof of a handle.
  gutters: string[]
  agentSessions: Array<{ id: string; status: string }>
  reviewQueue: number
  storeError?: string
  bootError?: string
  focusMode?: boolean
  errors: { count: number; recent: string[] }
  error?: string
}

/** What `probe` prints. */
export interface Snapshot extends Omit<RendererState, 'tree'> {
  tree: TreeNode | null
  // What sits on a gutter rather than in a pane — the `+` that opens one in the
  // gap — keyed by the gutter's id.
  gutterElements: Record<string, ProbeElement[]>
  // Everything portalled out of the pane tree: menus, modals, the top bar.
  overlays: ProbeElement[]
  filter?: string
}
