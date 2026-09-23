// Reactive owner of the split-tree layout. All tree mutations funnel through
// here (thin wrappers over the pure layoutTree ops) so persistence and focus
// stay in one place. Restored on repo open, saved debounced to per-repo state.
//
// There is exactly one layout model: every window — the sidebar, the editor,
// the agent panel — is a leaf of the split tree, so all of them drag, split,
// resize and close the same way.

import { store } from './store.svelte'
import { keymap } from './keymap.svelte'
import { panes } from './panes.svelte'
import { views } from './views.svelte'
import { CENTER_SLOT } from './paneSlots'
import { clampFontScale, steppedFontScale, FONT_SCALE_DEFAULT } from './fontScale'
import type { DockLayoutState, DockSide } from '../../../shared/types'
import {
  createLeaf,
  leaves,
  findLeaf,
  findParentSplit,
  findSplit,
  insertAtEdge,
  paneTypesInSlot,
  pathToLeaf,
  splitLeaf,
  removeLeaf,
  resizeGutter,
  swapLeaves,
  replaceLeafType,
  setLeafSizePx,
  updateLeafState,
  moveLeaf,
  sanitize,
  syncNvimWindowLeaves,
  type DropZone,
  type EdgeSide,
  type LayoutNode,
  type LeafNode,
  type NvimWindowPlacement,
  type SizingPolicy,
  type SplitDirection,
  type SplitNode
} from './layoutTree'

// Sizes for panels nested INSIDE pane components (file tree rows) — not part of
// the split tree, still persisted alongside it.
const DEFAULT_PANEL_SIZES: Record<string, number> = {
  tree: 224
}

// Center pane types a layout saved before the split tree may name. Only read
// when restoring that old state; live layouts carry their tree.
const CENTER_TYPES = ['nvim']

// The editor is the one pane a slot swap may never take over — everything else
// opens beside it. Losing the editor to a pane with no way back stranded the
// user (settings did exactly that).
const EDITOR_TYPE = 'nvim'

// Center pane type shown when the last real center pane is closed, so the
// center never collapses to nothing.
const EMPTY_CENTER_TYPE = 'empty'

// Share of the tree an edge pane takes when it has no preference of its own.
const DEFAULT_EDGE_FRACTION = 0.2

interface DefaultTreeOptions {
  centerType?: string
}

/** One open pane, flattened for a harness to read. */
export interface PaneSummary {
  kind: 'leaf'
  id: string
  paneTypeId: string
  title: string
  focused: boolean
  // Absent unless notable: see summariseLeaf.
  registered?: boolean
  slot?: string
  sizePx?: number
  paneState?: Record<string, unknown>
}

export interface SplitSummary {
  kind: 'split'
  id: string
  direction: SplitDirection
  sizes: number[]
  children: LayoutSummary[]
}

export type LayoutSummary = PaneSummary | SplitSummary

// The starting layout: the center pane flanked by whichever pane types asked
// for the left and right edges (the explorer and the agent panel, as they
// register themselves). Exported for the base "code" view definition.
export function buildDefaultTree(options: DefaultTreeOptions = {}): LayoutNode {
  let tree: LayoutNode = createLeaf(options.centerType ?? 'nvim')
  for (const side of ['left', 'right'] as const) {
    const type = panes.edgeTypes(side)[0]
    if (!type) continue
    tree = insertAtEdge(tree, createPaneLeaf(type.id), side, edgeFraction(type.id))
  }
  return tree
}

// How much of the tree a pane type claims when it arrives at its edge.
function edgeFraction(paneTypeId: string): number {
  return panes.get(paneTypeId)?.preferredEdge?.fraction ?? DEFAULT_EDGE_FRACTION
}

/**
 * A leaf for this pane type, already carrying the pixel size fixed panes start
 * at so a sidebar opens at its own width instead of a share of the window.
 */
function createPaneLeaf(paneTypeId: string, paneState?: Record<string, unknown>): LeafNode {
  const leaf = createLeaf(paneTypeId, paneState)
  const fixed = panes.get(paneTypeId)?.fixedSize
  if (!fixed) return leaf
  return { ...leaf, sizePx: fixed.defaultPx }
}

// Which outer edge a pane type belongs against when nothing of it is open.
function edgeFor(paneTypeId: string): EdgeSide | null {
  return panes.get(paneTypeId)?.preferredEdge?.side ?? null
}

/**
 * The centre panes a freshly built view consists of — what the view *is*, as
 * opposed to the sidebar and chrome it happens to open with. Taken from the
 * view's own tree rather than a list here, so a new view needs no change.
 */
function centrePaneTypes(tree: LayoutNode): string[] {
  return paneTypesInSlot(tree, CENTER_SLOT, (paneTypeId) => panes.get(paneTypeId)?.slot)
}

// Smallest a pane may be dragged to before the gutter starts counting overshoot
// towards closing it.
const MIN_PANE_PX = 120

/** Whether this node is a pane that holds a pixel size rather than a share. */
function holdsFixedSize(node: LayoutNode): boolean {
  if (node.kind !== 'leaf') return false
  return panes.get(node.paneTypeId)?.fixedSize !== undefined
}

/**
 * Pixels a fixed-size pane holds, or null when the pane sizes itself as a share
 * of the window like the editor does. Also null for a fixed pane that has not
 * been measured yet — it renders as a share for that one frame, so restoring a
 * layout saved before fixed sizing keeps the width the user already had.
 */
export function fixedPaneSize(node: LayoutNode): number | null {
  if (!holdsFixedSize(node)) return null
  return (node as LeafNode).sizePx ?? null
}

/**
 * Which pane makes room for a window opened in a gap, and on which side of it
 * the newcomer goes. Normally the pane left of the gap is halved; when that one
 * holds a fixed size it has nothing to give, so the pane on the right is halved
 * instead and the newcomer still lands against the gap.
 */
function gutterAnchor(
  split: SplitNode,
  gutterIndex: number
): { leaf: LeafNode; position: 'before' | 'after' } | null {
  // Either side of the gap may be a whole subtree; the pane touching the gap is
  // its last (left side) or first (right side) in render order.
  const before = leaves(split.children[gutterIndex]).at(-1)
  const after = leaves(split.children[gutterIndex + 1])[0]
  if (before && fixedPaneSize(before) === null) return { leaf: before, position: 'after' }
  if (after && fixedPaneSize(after) === null) return { leaf: after, position: 'before' }
  if (before) return { leaf: before, position: 'after' }
  return null
}

// Redistribution weights read off the pane registry: fixed panes never take or
// give, the editor grows first, the agent panel yields first.
const sizingPolicy: SizingPolicy = {
  growthOf(node: LayoutNode): number {
    if (fixedPaneSize(node) !== null) return 0
    if (node.kind === 'leaf') return panes.get(node.paneTypeId)?.growth ?? 1
    // A split is as eager as the panes inside it that can resize at all.
    const flexible = leaves(node).filter((leaf) => fixedPaneSize(leaf) === null)
    if (flexible.length === 0) return 0
    const total = flexible.reduce((sum, leaf) => sum + (panes.get(leaf.paneTypeId)?.growth ?? 1), 0)
    return total / flexible.length
  }
}

class LayoutStore {
  activeViewId = $state<string>('code')
  paneSizes = $state<Record<string, number>>({ ...DEFAULT_PANEL_SIZES })

  // Per-pane font zoom, keyed by split-tree leaf id. Absent key means unscaled
  // (1). Panes read this to size their content (CSS zoom for DOM panes, own
  // font for canvas panes).
  paneFontScale = $state<Record<string, number>>({})

  // Distraction-free focus mode: hide the rail and show only the focused pane,
  // the rest of the tree staying mounted behind it.
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

  // Most recently focused leaf per pane slot, so opening a pane anchors on the
  // window of its own family — a second editor lands beside the editor you were
  // last in, never beside the sidebar that happens to hold focus. Deliberately
  // not reactive: it is bookkeeping read inside event handlers.
  private lastLeafBySlot: Record<string, string> = {}

  // Nodes on the path from the root to the focused leaf. Focus mode renders
  // only this branch, so the focused pane fills the body while everything else
  // stays mounted (hidden) instead of being torn down and rebuilt.
  zoomPath = $derived.by<Set<string>>(() => {
    if (!this.focusMode) return new Set<string>()
    const leafId = keymap.activeLeafId ?? leaves(this.tree)[0]?.id
    if (!leafId) return new Set<string>()
    return new Set(pathToLeaf(this.tree, leafId) ?? [])
  })

  // A leaf dragged past its collapse point while the drag is still held. It is
  // hidden rather than closed, so pulling the divider back brings it back, and
  // only closes once the drag is released.
  collapsingLeafId = $state<string | null>(null)

  // Whether a node renders at all — false for the branches focus mode folds
  // away and for a leaf mid-collapse.
  isNodeVisible(nodeId: string): boolean {
    if (nodeId === this.collapsingLeafId) return false
    if (!this.focusMode) return true
    return this.zoomPath.has(nodeId)
  }

  // ── Fixed-size panes ──────────────────────────────────────────
  /**
   * Pixels this leaf holds along its parent's axis, or null when it sizes
   * itself as a share of the window. SplitTree renders the difference.
   */
  fixedSizePx(node: LayoutNode): number | null {
    return fixedPaneSize(node)
  }

  /**
   * Resize a fixed pane. Sizes below its minimum are kept (so the gutter can
   * count how far past the stop the user dragged) but never below zero.
   */
  setFixedSizePx(leafId: string, px: number): void {
    const next = Math.max(0, Math.round(px))
    this.setActiveTree(setLeafSizePx(this.tree, leafId, next))
    this.schedule()
  }

  /**
   * Give a fixed pane the width it is currently rendering at, once. Called by
   * SplitTree the first time such a pane is measured, which is what carries a
   * layout saved before fixed sizing across without resizing anything.
   */
  adoptFixedSizePx(leafId: string, px: number): void {
    const leaf = findLeaf(this.tree, leafId)
    if (!leaf || typeof leaf.sizePx === 'number') return
    if (!holdsFixedSize(leaf) || px <= 0) return
    this.setFixedSizePx(leafId, px)
  }

  /**
   * Smallest this pane may be dragged to before the gutter counts the drag as
   * an attempt to close it.
   */
  minSizePx(node: LayoutNode, direction: SplitDirection): number {
    const sizes = leaves(node).map((leaf) => {
      const type = panes.get(leaf.paneTypeId)
      const px = direction === 'row' ? type?.minWidth : type?.minHeight
      return px ?? MIN_PANE_PX
    })
    return Math.max(MIN_PANE_PX, ...sizes)
  }

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

  // ── Per-pane font zoom ────────────────────────────────────────
  fontScale(containerId: string): number {
    return this.paneFontScale[containerId] ?? FONT_SCALE_DEFAULT
  }

  private setFontScale(containerId: string, value: number): void {
    const clamped = clampFontScale(value)
    // Default scale carries no state, so a reset drops the key entirely.
    if (clamped === FONT_SCALE_DEFAULT) {
      const { [containerId]: _removed, ...rest } = this.paneFontScale
      this.paneFontScale = rest
    } else {
      this.paneFontScale = { ...this.paneFontScale, [containerId]: clamped }
    }
    this.schedule()
  }

  // Container (split leaf or dock) whose font zoom the Ctrl +/-/0 keys target:
  // the box around the focused element, resolved via the DOM so a nested inner
  // pane (e.g. the file tree) still maps to its enclosing zoom container.
  private focusedZoomContainerId(): string | null {
    const active = document.activeElement as HTMLElement | null
    const container = active?.closest('[data-zoom-container]') as HTMLElement | null
    if (container?.dataset.zoomContainer) return container.dataset.zoomContainer
    if (keymap.activeLeafId) return keymap.activeLeafId
    return keymap.activePane
  }

  adjustFocusedFontScale(deltaSteps: number): void {
    const containerId = this.focusedZoomContainerId()
    if (!containerId) return
    this.setFontScale(containerId, steppedFontScale(this.fontScale(containerId), deltaSteps))
  }

  resetFocusedFontScale(): void {
    const containerId = this.focusedZoomContainerId()
    if (!containerId) return
    this.setFontScale(containerId, FONT_SCALE_DEFAULT)
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

  /**
   * Record that a leaf took focus, so the next pane of its family opens beside
   * it. Called by PaneLeaf when it becomes the active surface.
   */
  noteFocusedLeaf(leafId: string): void {
    const leaf = findLeaf(this.tree, leafId)
    if (!leaf) return
    const slot = panes.get(leaf.paneTypeId)?.slot
    if (!slot) return
    this.lastLeafBySlot[slot] = leafId
  }

  /**
   * The leaf a new pane of this type should grow out of. Panes belong to a slot
   * family (the editor family, the sidebar family); a pane with no family of its
   * own opens beside the editor. Within a family the focused leaf wins, then the
   * one focused most recently, then any leaf of the family.
   */
  private anchorLeafFor(paneTypeId: string): LeafNode | null {
    const slot = panes.get(paneTypeId)?.slot ?? CENTER_SLOT
    const focused = this.focusedLeaf()
    if (focused && panes.get(focused.paneTypeId)?.slot === slot) return focused
    const remembered = this.lastLeafBySlot[slot]
    const rememberedLeaf = remembered ? findLeaf(this.tree, remembered) : null
    if (rememberedLeaf && panes.get(rememberedLeaf.paneTypeId)?.slot === slot) return rememberedLeaf
    const familyLeaf = this.slotLeaf(slot)
    if (familyLeaf) return familyLeaf
    if (focused) return focused
    return leaves(this.tree)[0] ?? null
  }

  // ── Tree operations ───────────────────────────────────────────
  // Split a pane in two. With a pane type given the split grows out of that
  // type's anchor (a second editor lands beside the editor, not beside whatever
  // chrome pane holds focus); without one it duplicates the focused pane.
  splitFocused(direction: SplitDirection, paneTypeId?: string): void {
    const anchor = paneTypeId
      ? this.anchorLeafFor(paneTypeId)
      : (this.focusedLeaf() ?? leaves(this.tree)[0])
    if (!anchor) return
    const newLeaf = createPaneLeaf(paneTypeId ?? anchor.paneTypeId)
    this.setActiveTree(splitLeaf(this.tree, anchor.id, direction, newLeaf))
    this.focusLeafSoon(newLeaf.id)
    this.schedule()
  }

  /**
   * Open a pane in the gap between two siblings — what the `+` on a gutter
   * does. The pane on the left of the gap is halved to make room, so the new
   * window lands exactly where the button was.
   */
  insertAtGutter(splitId: string, gutterIndex: number, paneTypeId: string): void {
    const split = findSplit(this.tree, splitId)
    if (!split) return
    const anchor = gutterAnchor(split, gutterIndex)
    if (!anchor) return
    const newLeaf = createPaneLeaf(paneTypeId)
    this.setActiveTree(
      splitLeaf(this.tree, anchor.leaf.id, split.direction, newLeaf, anchor.position)
    )
    this.focusLeafSoon(newLeaf.id)
    this.schedule()
  }

  // Mirror an editor's Neovim windows into transient leaves beside it. The tree
  // written is the one holding the owning pane, not the active one: an editor in
  // a mounted-but-hidden view keeps reporting its windows.
  syncNvimWindows(ownerLeafId: string, nvimId: string, windows: NvimWindowPlacement[]): void {
    const viewId = this.viewHoldingLeaf(ownerLeafId)
    if (!viewId) return
    const tree = this.trees[viewId]
    const next = syncNvimWindowLeaves(tree, ownerLeafId, nvimId, windows)
    if (next !== tree) this.trees[viewId] = next
  }

  /** The mounted view whose tree holds this leaf, or null once it is gone. */
  private viewHoldingLeaf(leafId: string): string | null {
    for (const viewId of this.mountedViewIds) {
      const tree = this.trees[viewId]
      if (tree && findLeaf(tree, leafId)) return viewId
    }
    return null
  }

  // Whether any leaf of the given pane type is open in the active view.
  hasPaneType(paneTypeId: string): boolean {
    return leaves(this.tree).some((leaf) => leaf.paneTypeId === paneTypeId)
  }

  /**
   * Every open pane as plain data, in render order — what the debug harnesses
   * print when asked what is on screen. Reactive state is copied out, not
   * handed over: both callers serialise the result.
   */
  leafSummary(): PaneSummary[] {
    return leaves(this.tree).map((leaf) => this.summariseLeaf(leaf))
  }

  /**
   * The active view's tree as plain data, splits included.
   *
   * The flat summary says which panes exist; this says how they sit next to each
   * other, which is what a harness needs to target a gutter or understand a
   * layout it did not build.
   */
  treeSummary(): LayoutSummary {
    const describe = (node: LayoutNode): LayoutSummary => {
      if (node.kind === 'leaf') return this.summariseLeaf(node)
      return {
        kind: 'split',
        id: node.id,
        direction: node.direction,
        sizes: [...node.sizes],
        children: node.children.map(describe)
      }
    }
    return describe(this.tree)
  }

  private summariseLeaf(leaf: LeafNode): PaneSummary {
    const type = panes.get(leaf.paneTypeId)
    const summary: PaneSummary = {
      kind: 'leaf',
      id: leaf.id,
      paneTypeId: leaf.paneTypeId,
      title: type?.title ?? leaf.paneTypeId,
      focused: keymap.activeLeafId === leaf.id
    }
    // Only what distinguishes this pane from the default: a registered type, a
    // family, a size it holds itself, state it was opened with.
    if (!type) summary.registered = false
    if (type?.slot) summary.slot = type.slot
    if (typeof leaf.sizePx === 'number') summary.sizePx = leaf.sizePx
    if (leaf.paneState) summary.paneState = { ...leaf.paneState }
    return summary
  }

  closeLeaf(leafId: string): void {
    const leaf = findLeaf(this.tree, leafId)
    if (!leaf) return
    // Neither the tree nor the center may collapse to nothing: closing the last
    // window, or the last center window, swaps in an empty-state placeholder
    // instead of removing it.
    if (this.isLastCenterLeaf(leaf) || leaves(this.tree).length <= 1) {
      if (leaf.paneTypeId === EMPTY_CENTER_TYPE) return
      this.setActiveTree(replaceLeafType(this.tree, leaf.id, EMPTY_CENTER_TYPE))
      this.schedule()
      return
    }
    const next = removeLeaf(this.tree, leafId, sizingPolicy)
    if (!next) return
    this.setActiveTree(next)
    const fallback = leaves(next)[0]
    if (keymap.activeLeafId === leafId && fallback) this.focusLeafSoon(fallback.id)
    this.schedule()
  }

  // Whether this leaf is the only window of the editor family left open.
  private isLastCenterLeaf(leaf: LeafNode): boolean {
    if (panes.get(leaf.paneTypeId)?.slot !== CENTER_SLOT) return false
    const centerLeaves = leaves(this.tree).filter(
      (entry) => panes.get(entry.paneTypeId)?.slot === CENTER_SLOT
    )
    return centerLeaves.length <= 1
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
    const next = moveLeaf(this.tree, draggedId, targetId, zone, sizingPolicy)
    if (next === this.tree) return
    this.setActiveTree(next)
    this.focusLeafSoon(draggedId)
    this.schedule()
  }

  resize(
    splitId: string,
    gutterIndex: number,
    deltaFraction: number,
    minBefore?: number,
    minAfter?: number
  ): void {
    this.setActiveTree(
      resizeGutter(this.tree, splitId, gutterIndex, deltaFraction, minBefore, minAfter)
    )
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

  // Reveal a pane of this type: focus it if a window already shows it, take
  // over the window of a same-family pane, pin it against its preferred edge,
  // or split the pane it anchors on.
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
    // Aux panes that declare an orientation split their anchor rather than
    // replacing it, so the editor stays open beside/below them.
    const definition = panes.get(paneTypeId)
    if (definition?.preferredOrientation) {
      this.splitFocused(definition.preferredOrientation, paneTypeId)
      return
    }
    if (this.takeOverSlotMate(paneTypeId)) return
    const edge = edgeFor(paneTypeId)
    if (edge) {
      this.openAtEdge(paneTypeId, edge)
      return
    }
    this.splitFocused('row', paneTypeId)
  }

  // Swap this type into the open window of its own family (one sidebar view
  // replacing another). Returns false when there is no such window, or when it
  // holds the editor — losing the editor to a pane with no way back stranded
  // the user, so the editor is split beside instead.
  private takeOverSlotMate(paneTypeId: string): boolean {
    const slot = panes.get(paneTypeId)?.slot
    if (!slot) return false
    const slotMate = this.slotLeaf(slot)
    if (!slotMate) return false
    if (slotMate.paneTypeId === EDITOR_TYPE) {
      this.splitFocused('row', paneTypeId)
      return true
    }
    // The same stranding, one level up: a named view is its centre pane, so
    // replacing that pane leaves the view showing something else entirely —
    // and the swap is persisted, so it never comes back. Split beside it.
    if (this.isActiveViewCentre(slotMate.paneTypeId)) {
      this.splitFocused('row', paneTypeId)
      return true
    }
    this.setActiveTree(replaceLeafType(this.tree, slotMate.id, paneTypeId))
    this.focusLeafSoon(slotMate.id)
    this.schedule()
    return true
  }

  // Pin a new window for this type against an outer edge of the tree.
  private openAtEdge(paneTypeId: string, edge: EdgeSide): void {
    const leaf = createPaneLeaf(paneTypeId)
    this.setActiveTree(insertAtEdge(this.tree, leaf, edge, edgeFraction(paneTypeId), sizingPolicy))
    this.focusLeafSoon(leaf.id)
    this.schedule()
  }

  // Toggle the pane that owns an outer edge: close whichever edge pane is open
  // there, or bring back the type that asked for that edge first. Keeps the
  // "toggle the right panel" command working without naming a pane type.
  toggleEdgePane(edge: EdgeSide): void {
    const open = leaves(this.tree).find((leaf) => edgeFor(leaf.paneTypeId) === edge)
    if (open) {
      this.closeLeaf(open.id)
      return
    }
    const type = panes.edgeTypes(edge)[0]
    if (type) this.ensurePane(type.id)
  }

  togglePane(paneTypeId: string): void {
    const inTree = leaves(this.tree).find((leaf) => leaf.paneTypeId === paneTypeId)
    if (!inTree) {
      this.ensurePane(paneTypeId)
      return
    }
    this.closeLeaf(inTree.id)
  }

  // Show a center pane (the editor, the markdown preview, the problems list).
  // `focus: false` shows it without taking focus from wherever it is.
  showCenterPane(paneTypeId: string, options: { focus?: boolean } = {}): void {
    if (!CENTER_TYPES.includes(paneTypeId) && !panes.get(paneTypeId)) return
    if (options.focus === false) {
      this.revealPane(paneTypeId)
      return
    }
    this.ensurePane(paneTypeId)
  }

  /** Opens a pane of this type if none is open, leaving focus where it was. */
  private revealPane(paneTypeId: string): void {
    if (leaves(this.tree).some((leaf) => leaf.paneTypeId === paneTypeId)) return
    const focusedLeafId = keymap.activeLeafId
    const focusedElement = document.activeElement
    this.ensurePane(paneTypeId)
    // ensurePane focuses the new leaf on the next frame; hand focus back after
    // it, down to the element, so a composer being typed in keeps its caret.
    requestAnimationFrame(() => {
      if (focusedLeafId) keymap.focusPane(focusedLeafId)
      if (focusedElement instanceof HTMLElement) focusedElement.focus()
    })
  }

  // ── Views ─────────────────────────────────────────────────────
  // Switch to a named view. The previous view stays mounted (hidden) and the
  // target is mounted on first visit, then kept — so switching only flips which
  // subtree is visible instead of tearing down and rebuilding panes.
  switchView(viewId: string): void {
    const definition = views.get(viewId)
    if (!definition) return
    this.ensureMounted(viewId, definition)
    this.activeViewId = viewId
    this.reopenViewCentre(definition)
    this.focusInitial(definition)
    this.schedule()
  }

  /**
   * Reopen the pane a view is built around when its tree no longer holds it.
   * Editors and other panes join a view freely — opening a pull request's files
   * puts one in the GitHub view — and closing the view's own pane afterwards is
   * allowed, which used to leave the view showing something else with no way to
   * ask for it back: switching to a view already active did nothing at all.
   */
  private reopenViewCentre(definition: { buildTree: () => LayoutNode }): void {
    const centreTypes = centrePaneTypes(definition.buildTree())
    if (centreTypes.length === 0) return
    const open = leaves(this.tree).map((leaf) => leaf.paneTypeId)
    for (const paneTypeId of centreTypes) {
      if (open.includes(paneTypeId)) return
    }
    this.ensurePane(centreTypes[0])
  }

  // Give a view a live tree and add it to the render list if it isn't mounted.
  private ensureMounted(viewId: string, definition: { buildTree: () => LayoutNode }): void {
    if (this.trees[viewId]) return
    this.trees[viewId] = this.restoredTree(viewId, definition)
    this.mountedViewIds = [...this.mountedViewIds, viewId]
  }

  /**
   * The tree a view opens with: what was saved for it, unless that no longer
   * holds any of the panes the view is built around. A layout saved in that
   * state shows the wrong thing forever, so it is dropped for a fresh one.
   */
  private restoredTree(viewId: string, definition: { buildTree: () => LayoutNode }): LayoutNode {
    const stored = this.storedTrees[viewId]
    if (!stored) return definition.buildTree()
    const centreTypes = centrePaneTypes(definition.buildTree())
    if (centreTypes.length === 0) return stored
    const kept = leaves(stored).some((leaf) => centreTypes.includes(leaf.paneTypeId))
    if (kept) return stored
    return definition.buildTree()
  }

  /** Whether a pane type is one the active view is built around. */
  private isActiveViewCentre(paneTypeId: string): boolean {
    const definition = views.get(this.activeViewId)
    if (!definition) return false
    return centrePaneTypes(definition.buildTree()).includes(paneTypeId)
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
    paneFontScale?: Record<string, number>
    panelsOpen?: Record<string, boolean>
    centerView?: string | null
    docks?: DockLayoutState | null
    focusMode?: boolean
  }): void {
    this.ready = false
    this.paneSizes = { ...DEFAULT_PANEL_SIZES, ...(state.paneSizes || {}) }
    this.paneFontScale = { ...(state.paneFontScale || {}) }
    this.focusMode = state.focusMode === true
    this.storedTrees = adoptDocks(restoreViewTrees(state.viewLayouts), state.docks)
    const activeId = this.restoreActiveViewId(state.activeLayoutView)
    this.activeViewId = activeId
    // Mount only the active view; others mount lazily on first switch.
    const activeTree = this.storedTrees[activeId] ?? this.initialTree(activeId, state)
    this.trees = { [activeId]: activeTree }
    this.mountedViewIds = [activeId]
    this.ready = true
    // Adopting the old docks is a one-shot: persist immediately so the next
    // launch reads them back as null and leaves the tree alone.
    if (state.docks) this.schedule()
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
    // Legacy pre-tree state only carries a preferred center pane; the default
    // tree brings its own edge panes back.
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
          ...Object.fromEntries(
            Object.entries($state.snapshot(this.trees) as Record<string, LayoutNode>).map(
              ([id, tree]) => [id, stripTransientNvimGrids(tree) ?? buildDefaultTree()]
            )
          )
        },
        activeLayoutView: this.activeViewId,
        paneSizes: $state.snapshot(this.paneSizes),
        paneFontScale: $state.snapshot(this.paneFontScale),
        // Docks are gone — the sidebar and agent panel are leaves of the tree
        // above. Writing null retires the legacy field so it is adopted once.
        docks: null,
        focusMode: this.focusMode,
        // Tabs are per worktree; persist the full maps (paths only). Scratch
        // buffers are ephemeral (backed by a live nvim buffer) — never persist
        // them, and don't leave a scratch key as the persisted active tab.
        openTabsByWorktree: Object.fromEntries(
          Object.entries(store.tabsByWorktree).map(([worktreeId, tabs]) => [
            worktreeId,
            tabs.filter((tab) => !tab.scratch).map((tab) => tab.path)
          ])
        ),
        activeTabByWorktree: Object.fromEntries(
          Object.entries(store.tabsByWorktree).map(([worktreeId, tabs]) => {
            const files = tabs.filter((tab) => !tab.scratch)
            const active = store.activeTabByWorktree[worktreeId]
            const activeIsFile = active && files.some((tab) => tab.path === active)
            const fallback = files.length > 0 ? files[files.length - 1].path : null
            return [worktreeId, activeIsFile ? active : fallback]
          })
        )
      })
    } catch {
      // best-effort; layout is non-critical
    }
  }
}

// Neovim-derived leaves are reconstructed from win_pos after attach. Persisting
// process-local grid/window ids would restore dead panes on the next launch.
function stripTransientNvimGrids(node: LayoutNode): LayoutNode | null {
  if (node.kind === 'leaf') return node.paneState?.transient === true ? null : node
  const projected = node.children.map((child, index) => ({
    child: stripTransientNvimGrids(child),
    size: node.sizes[index]
  }))
  const kept = projected
    .map((entry) => entry.child)
    .filter((child): child is LayoutNode => child !== null)
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]
  const sizes = projected.filter((entry) => entry.child !== null).map((entry) => entry.size)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return { ...node, children: kept, sizes: sizes.map((size) => size / total) }
}

// Fold the retired left/right docks into every stored tree as ordinary leaves,
// keeping roughly the width they had. Runs once: the next save writes
// `docks: null`, after which stored trees already carry these panes.
function adoptDocks(
  trees: Record<string, LayoutNode>,
  docks: DockLayoutState | null | undefined
): Record<string, LayoutNode> {
  if (!docks) return trees
  const adopted: Record<string, LayoutNode> = {}
  for (const [viewId, tree] of Object.entries(trees)) {
    adopted[viewId] = (['left', 'right'] as DockSide[]).reduce(
      (node, side) => adoptDock(node, docks[side], side),
      tree
    )
  }
  return adopted
}

function adoptDock(
  tree: LayoutNode,
  dock: { paneType: string; open: boolean; size: number } | undefined,
  side: DockSide
): LayoutNode {
  if (!dock || !dock.open) return tree
  if (leaves(tree).some((leaf) => leaf.paneTypeId === dock.paneType)) return tree
  // Dock widths were pixels; the tree sizes in fractions of the window.
  const fraction = dock.size / Math.max(640, window.innerWidth)
  return insertAtEdge(tree, createLeaf(dock.paneType), side, fraction)
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
