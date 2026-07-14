// Reactive owner of the split-tree layout. All tree mutations funnel through
// here (thin wrappers over the pure layoutTree ops) so persistence and focus
// stay in one place. Restored on repo open, saved debounced to per-repo state.

import { store } from './store.svelte'
import { keymap } from './keymap.svelte'
import { panes } from './panes.svelte'
import { views } from './views.svelte'
import type { DockLayoutState, DockPaneState, DockSide } from '../../../shared/types'
import {
  createLeaf,
  leaves,
  findLeaf,
  findParentSplit,
  splitLeaf,
  removeLeaf,
  resizeGutter,
  swapLeaves,
  replaceLeafType,
  updateLeafState,
  moveLeaf,
  sanitize,
  type DropZone,
  type LayoutNode,
  type LeafNode,
  type SplitDirection,
  type SplitNode
} from './layoutTree'

// Sizes for panels nested INSIDE pane components (file tree rows) — not part of
// the split tree, still persisted alongside it.
const DEFAULT_PANEL_SIZES: Record<string, number> = {
  tree: 224
}

const CENTER_TYPES = ['nvim', 'dashboard']

// Center pane type shown when the last real center pane is closed, so the
// center never collapses to nothing.
const EMPTY_CENTER_TYPE = 'empty'

// Default docked panels: file explorer on the left, agent panel on the right.
// Docks live outside the split tree and stay attached; only the center splits.
const DEFAULT_DOCKS: DockLayoutState = {
  left: { paneType: 'files', open: true, size: 256 },
  right: { paneType: 'agent', open: true, size: 340 }
}

const MIN_DOCK_PX = 160
// Dragging this far below the min width collapses the dock instead of clamping.
const DOCK_COLLAPSE_SLOP_PX = 48
// Per-side max width: the left explorer should stay compact; the right utility
// dock (agent chat / terminal) may grow wider.
const MAX_DOCK_PX: Record<DockSide, number> = { left: 420, right: 720 }

interface DefaultTreeOptions {
  centerType?: string
}

// The center split tree. Sidebar (left dock) and agent (right dock) now live in
// docks, so the default tree is just the center editor. Exported for the base
// "code" view definition.
export function buildDefaultTree(options: DefaultTreeOptions = {}): LayoutNode {
  return createLeaf(options.centerType ?? 'nvim')
}

function clampDockPx(side: DockSide, px: number): number {
  return Math.min(MAX_DOCK_PX[side], Math.max(MIN_DOCK_PX, px))
}

function cloneDocks(source: DockLayoutState): DockLayoutState {
  return {
    left: { ...source.left },
    right: { ...source.right }
  }
}

// Stable focusable-pane id for a dock (registered by DockPane via use:pane).
export function dockLeafId(side: DockSide): string {
  return `dock:${side}`
}

// Panes registered with this slot are navigation sidebars → left dock.
const SIDEBAR_SLOT_ID = 'sidebar'

// Which dock (if any) a pane type belongs in when it isn't already open in the
// center tree: sidebar panes dock left, the agent panel docks right.
function dockSideFor(paneTypeId: string): DockSide | null {
  if (panes.get(paneTypeId)?.slot === SIDEBAR_SLOT_ID) return 'left'
  if (paneTypeId === 'agent') return 'right'
  return null
}

class LayoutStore {
  activeViewId = $state<string>('code')
  paneSizes = $state<Record<string, number>>({ ...DEFAULT_PANEL_SIZES })

  // Docked side panels, shared across all views (they stay attached; only the
  // center split tree is per-view and freely splittable).
  docks = $state<DockLayoutState>(cloneDocks(DEFAULT_DOCKS))

  // Distraction-free focus mode: hide the docks + rail and float the center.
  focusMode = $state<boolean>(false)

  // Live tree per MOUNTED view. Views the user has visited stay in the DOM
  // (hidden when inactive) so switching back never remounts their panes — that
  // remount was rebuilding the editor and every AgentPane message on each
  // switch. Only the active view's tree is ever mutated.
  trees = $state<Record<string, LayoutNode>>({ code: buildDefaultTree() })

  // Render order of mounted views. App iterates this, showing only the active.
  mountedViewIds = $state<string[]>(['code'])

  // Snapshots restored from disk for views not yet visited this session; used
  // to seed a view's live tree the first time it is shown.
  private storedTrees: Record<string, LayoutNode> = {}
  private ready = false
  private timer: ReturnType<typeof setTimeout> | null = null

  // The active view's live tree. All tree ops read and write through here.
  get tree(): LayoutNode {
    return this.trees[this.activeViewId] ?? buildDefaultTree()
  }

  private setActiveTree(next: LayoutNode): void {
    this.trees[this.activeViewId] = next
  }

  size(key: string): number {
    return this.paneSizes[key] ?? DEFAULT_PANEL_SIZES[key] ?? 256
  }

  // ── Docks ─────────────────────────────────────────────────────
  dock(side: DockSide): DockPaneState {
    return this.docks[side]
  }

  private setDock(side: DockSide, patch: Partial<DockPaneState>): void {
    this.docks = { ...this.docks, [side]: { ...this.docks[side], ...patch } }
    this.schedule()
  }

  // Show a pane type in a dock, opening it. Clicking the type already shown in
  // an open dock toggles it closed (rail behaviour).
  showInDock(side: DockSide, paneType: string): void {
    const current = this.docks[side]
    if (current.open && current.paneType === paneType) {
      this.setDock(side, { open: false })
      return
    }
    this.setDock(side, { paneType, open: true })
    this.focusLeafSoon(dockLeafId(side))
  }

  // Open a dock showing a pane type and focus it (no toggle) — used by
  // ensurePane and commands that must reveal, not flip.
  openDock(side: DockSide, paneType?: string): void {
    const next = paneType ?? this.docks[side].paneType
    this.setDock(side, { paneType: next, open: true })
    this.focusLeafSoon(dockLeafId(side))
  }

  toggleDock(side: DockSide): void {
    this.setDock(side, { open: !this.docks[side].open })
  }

  setDockOpen(side: DockSide, open: boolean): void {
    if (this.docks[side].open === open) return
    this.setDock(side, { open })
  }

  // Resize a dock, or collapse it when dragged well below the min width. The
  // center can't collapse this way — its gutters are fraction-clamped and the
  // never-empty guard keeps a pane present.
  resizeDock(side: DockSide, px: number): void {
    if (px < MIN_DOCK_PX - DOCK_COLLAPSE_SLOP_PX) {
      this.setDockOpen(side, false)
      return
    }
    this.setDock(side, { size: clampDockPx(side, px) })
  }

  toggleFocusMode(): void {
    this.focusMode = !this.focusMode
    this.schedule()
  }

  // ── Focus ─────────────────────────────────────────────────────
  focusedLeaf(): LeafNode | null {
    if (!keymap.activeLeafId) return null
    return findLeaf(this.tree, keymap.activeLeafId)
  }

  private focusLeafSoon(leafId: string): void {
    // The leaf may not be mounted yet; focus after the DOM settles.
    requestAnimationFrame(() => keymap.focusPane(leafId))
  }

  // ── Tree operations ───────────────────────────────────────────
  splitFocused(direction: SplitDirection, paneTypeId?: string): void {
    const focused = this.focusedLeaf() ?? leaves(this.tree)[0]
    if (!focused) return
    const newLeaf = createLeaf(paneTypeId ?? focused.paneTypeId)
    this.setActiveTree(splitLeaf(this.tree, focused.id, direction, newLeaf))
    this.focusLeafSoon(newLeaf.id)
    this.schedule()
  }

  // Whether any leaf of the given pane type is open in the active view.
  hasPaneType(paneTypeId: string): boolean {
    return leaves(this.tree).some((leaf) => leaf.paneTypeId === paneTypeId)
  }

  closeLeaf(leafId: string): void {
    // Never let the center collapse to nothing: closing the last pane swaps it
    // for an empty-state placeholder instead of removing it.
    if (leaves(this.tree).length <= 1) {
      const only = leaves(this.tree)[0]
      if (only && only.id === leafId && only.paneTypeId !== EMPTY_CENTER_TYPE) {
        this.setActiveTree(replaceLeafType(this.tree, only.id, EMPTY_CENTER_TYPE))
        this.schedule()
      }
      return
    }
    const next = removeLeaf(this.tree, leafId)
    if (!next) return
    this.setActiveTree(next)
    const fallback = leaves(next)[0]
    if (keymap.activeLeafId === leafId && fallback) this.focusLeafSoon(fallback.id)
    this.schedule()
  }

  closeFocused(): void {
    const focused = this.focusedLeaf()
    if (focused) this.closeLeaf(focused.id)
  }

  // Move the focused leaf directionally by swapping with its neighbor.
  moveFocused(dir: 'h' | 'j' | 'k' | 'l'): void {
    const focused = this.focusedLeaf()
    if (!focused) return
    const leafIds = new Set(leaves(this.tree).map((leaf) => leaf.id))
    const neighborId = keymap.neighborPane(focused.id, dir, leafIds)
    if (!neighborId) return
    this.setActiveTree(swapLeaves(this.tree, focused.id, neighborId))
    this.focusLeafSoon(focused.id)
    this.schedule()
  }

  // Relocate a leaf onto a target via drag-and-drop (see paneDrag controller).
  moveLeaf(draggedId: string, targetId: string, zone: DropZone): void {
    const next = moveLeaf(this.tree, draggedId, targetId, zone)
    if (next === this.tree) return
    this.setActiveTree(next)
    this.focusLeafSoon(draggedId)
    this.schedule()
  }

  resize(splitId: string, gutterIndex: number, deltaFraction: number, minFraction?: number): void {
    this.setActiveTree(resizeGutter(this.tree, splitId, gutterIndex, deltaFraction, minFraction))
    this.schedule()
  }

  // Grow (positive) or shrink (negative) the focused leaf by a pixel amount
  // along its parent split's axis. The last child has no gutter after it, so
  // its boundary is the gutter before it — invert the delta there so "grow"
  // always enlarges the pane.
  resizeFocused(deltaPx: number): void {
    const focused = this.focusedLeaf()
    if (!focused) return
    const parent = findParentSplit(this.tree, focused.id)
    if (!parent) return
    const index = parent.children.findIndex((child) => child.id === focused.id)
    if (index < 0) return
    const containerPx = this.splitContainerPx(parent)
    if (containerPx <= 0) return
    const isLastChild = index === parent.children.length - 1
    const gutterIndex = isLastChild ? index - 1 : index
    const signedPx = isLastChild ? -deltaPx : deltaPx
    this.resize(parent.id, gutterIndex, signedPx / containerPx)
  }

  // Pixel extent of a split's flex container along its own axis, used to turn
  // pixel resize deltas into size fractions. Zero when the split isn't mounted.
  private splitContainerPx(split: SplitNode): number {
    const element = document.querySelector<HTMLElement>(`[data-split-id="${split.id}"]`)
    if (!element) return 0
    return split.direction === 'row' ? element.clientWidth : element.clientHeight
  }

  setLeafType(leafId: string, paneTypeId: string, paneState?: Record<string, unknown>): void {
    this.setActiveTree(replaceLeafType(this.tree, leafId, paneTypeId, paneState))
    this.schedule()
  }

  updateLeafState(leafId: string, patch: Record<string, unknown>): void {
    this.setActiveTree(updateLeafState(this.tree, leafId, patch))
    this.schedule()
  }

  // ── Pane-type helpers (ActivityBar, header, commands) ─────────
  hasPane(paneTypeId: string): boolean {
    return leaves(this.tree).some((leaf) => leaf.paneTypeId === paneTypeId)
  }

  // The pane type currently occupying a slot (e.g. which of editor/diff/…
  // fills the center slot) — drives active styling in the header and rail.
  slotType(slot: string): string | null {
    const leaf = this.slotLeaf(slot)
    return leaf ? leaf.paneTypeId : null
  }

  private slotLeaf(slot: string): LeafNode | null {
    const found = leaves(this.tree).find((leaf) => panes.get(leaf.paneTypeId)?.slot === slot)
    return found ?? null
  }

  // Reveal a pane of this type: focus it if already open in the center tree,
  // route sidebar/agent types to their dock, otherwise swap it into the center
  // slot or split the focused leaf.
  ensurePane(paneTypeId: string): void {
    // Prefer the invoking pane: when the focused leaf already has this type
    // (e.g. the editor split that opened the file finder), stay in it instead
    // of jumping to the first same-typed leaf in tree order.
    const focused = this.focusedLeaf()
    if (focused?.paneTypeId === paneTypeId) {
      this.focusLeafSoon(focused.id)
      return
    }
    const existing = leaves(this.tree).find((leaf) => leaf.paneTypeId === paneTypeId)
    if (existing) {
      this.focusLeafSoon(existing.id)
      return
    }
    // Not already in the center tree: sidebar panes dock left, agent docks right.
    const side = dockSideFor(paneTypeId)
    if (side) {
      this.openDock(side, paneTypeId)
      return
    }
    // Aux panes that declare an orientation split the current pane rather than
    // replacing it, so the editor stays open beside/below them.
    const definition = panes.get(paneTypeId)
    if (definition?.preferredOrientation) {
      this.splitFocused(definition.preferredOrientation, paneTypeId)
      return
    }
    const slotMate = definition?.slot ? this.slotLeaf(definition.slot) : null
    if (slotMate) {
      this.setActiveTree(replaceLeafType(this.tree, slotMate.id, paneTypeId))
      this.focusLeafSoon(slotMate.id)
      this.schedule()
      return
    }
    this.splitFocused('row', paneTypeId)
  }

  togglePane(paneTypeId: string): void {
    // A docked type toggles its dock, unless the user has also opened it in the
    // center tree (handled below).
    const side = dockSideFor(paneTypeId)
    const inTree = leaves(this.tree).find((leaf) => leaf.paneTypeId === paneTypeId)
    if (side && this.docks[side].paneType === paneTypeId && !inTree) {
      this.toggleDock(side)
      return
    }
    if (!inTree) {
      this.ensurePane(paneTypeId)
      return
    }
    this.closeLeaf(inTree.id)
  }

  // Show one of the center views (editor/diff/preview/dashboard).
  showCenterPane(paneTypeId: string): void {
    if (!CENTER_TYPES.includes(paneTypeId) && !panes.get(paneTypeId)) return
    this.ensurePane(paneTypeId)
  }

  // ── Views ─────────────────────────────────────────────────────
  // Switch to a named view. The previous view stays mounted (hidden) and the
  // target is mounted on first visit, then kept — so switching only flips which
  // subtree is visible instead of tearing down and rebuilding panes.
  switchView(viewId: string): void {
    if (viewId === this.activeViewId) return
    const definition = views.get(viewId)
    if (!definition) return
    this.ensureMounted(viewId, definition)
    this.activeViewId = viewId
    this.focusInitial(definition)
    this.schedule()
  }

  // Give a view a live tree and add it to the render list if it isn't mounted.
  private ensureMounted(viewId: string, definition: { buildTree: () => LayoutNode }): void {
    if (this.trees[viewId]) return
    this.trees[viewId] = this.storedTrees[viewId] ?? definition.buildTree()
    this.mountedViewIds = [...this.mountedViewIds, viewId]
  }

  private focusInitial(definition: { initialFocus?: string }): void {
    if (!definition.initialFocus) return
    const target = leaves(this.tree).find((leaf) => leaf.paneTypeId === definition.initialFocus)
    if (target) this.focusLeafSoon(target.id)
  }

  // ── Persistence ───────────────────────────────────────────────
  // Restore from persisted repo state (once per repo open). Suppresses saving
  // until the restored values are in place.
  apply(state: {
    viewLayouts?: Record<string, unknown>
    activeLayoutView?: string | null
    paneSizes?: Record<string, number>
    panelsOpen?: Record<string, boolean>
    centerView?: string | null
    docks?: DockLayoutState | null
    focusMode?: boolean
  }): void {
    this.ready = false
    this.paneSizes = { ...DEFAULT_PANEL_SIZES, ...(state.paneSizes || {}) }
    this.docks = this.restoreDocks(state)
    this.focusMode = state.focusMode === true
    this.storedTrees = restoreViewTrees(state.viewLayouts)
    const activeId = this.restoreActiveViewId(state.activeLayoutView)
    this.activeViewId = activeId
    // Mount only the active view; others mount lazily on first switch.
    const activeTree = this.storedTrees[activeId] ?? this.initialTree(activeId, state)
    this.trees = { [activeId]: activeTree }
    this.mountedViewIds = [activeId]
    this.ready = true
  }

  // Restore dock state, falling back to defaults and migrating legacy sidebar/
  // agent pixel sizes (from the pre-dock split-tree layout) into dock widths.
  private restoreDocks(state: {
    docks?: DockLayoutState | null
    paneSizes?: Record<string, number>
    panelsOpen?: Record<string, boolean>
  }): DockLayoutState {
    if (state.docks && state.docks.left && state.docks.right) {
      return {
        left: { ...DEFAULT_DOCKS.left, ...state.docks.left },
        right: { ...DEFAULT_DOCKS.right, ...state.docks.right }
      }
    }
    const legacy = state.paneSizes || {}
    const panels = state.panelsOpen || {}
    return {
      left: {
        ...DEFAULT_DOCKS.left,
        size: clampDockPx('left', legacy.sidebar ?? DEFAULT_DOCKS.left.size),
        open: panels.sidebar ?? true
      },
      right: {
        ...DEFAULT_DOCKS.right,
        size: clampDockPx('right', legacy.agent ?? DEFAULT_DOCKS.right.size),
        open: panels.agent ?? true
      }
    }
  }

  private restoreActiveViewId(stored: string | null | undefined): string {
    if (stored && views.get(stored)) return stored
    return views.get('code') ? 'code' : (views.views[0]?.id ?? 'code')
  }

  private initialTree(
    viewId: string,
    state: {
      centerView?: string | null
    }
  ): LayoutNode {
    // Legacy pre-tree state only carries a preferred center pane now; sidebar
    // and agent sizing migrate into docks (see restoreDocks).
    if (viewId === 'code' && state.centerView) {
      const centerView = state.centerView
      return buildDefaultTree({
        centerType: CENTER_TYPES.includes(centerView) ? centerView : 'nvim'
      })
    }
    const definition = views.get(viewId)
    if (definition) return definition.buildTree()
    return buildDefaultTree()
  }

  // Debounced persist. Also invoked by an App effect when open tabs change,
  // so one saver covers all layout state.
  schedule(): void {
    if (!this.ready) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 400)
  }

  private async flush(): Promise<void> {
    try {
      await window.workbench.state.update({
        // Unvisited views keep their stored layout; mounted views persist their
        // live tree over it.
        viewLayouts: {
          ...this.storedTrees,
          ...($state.snapshot(this.trees) as Record<string, LayoutNode>)
        },
        activeLayoutView: this.activeViewId,
        paneSizes: $state.snapshot(this.paneSizes),
        docks: $state.snapshot(this.docks) as DockLayoutState,
        focusMode: this.focusMode,
        openTabs: store.tabs.map((tab) => tab.path),
        activeTabPath: store.activeTabPath
      })
    } catch {
      // best-effort; layout is non-critical
    }
  }
}

// Sanitize every stored view tree; the phase-2 'default' key maps to 'code'.
function restoreViewTrees(raw: Record<string, unknown> | undefined): Record<string, LayoutNode> {
  const trees: Record<string, LayoutNode> = {}
  for (const [id, value] of Object.entries(raw ?? {})) {
    const tree = sanitize(value)
    if (!tree) continue
    const key = id === 'default' ? 'code' : id
    trees[key] = tree
  }
  return trees
}

export const layout = new LayoutStore()
