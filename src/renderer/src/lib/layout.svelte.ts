// Reactive owner of the split-tree layout. All tree mutations funnel through
// here (thin wrappers over the pure layoutTree ops) so persistence and focus
// stay in one place. Restored on repo open, saved debounced to per-repo state.

import { store } from './store.svelte'
import { keymap } from './keymap.svelte'
import { panes } from './panes.svelte'
import { views } from './views.svelte'
import {
  createLeaf,
  createSplit,
  leaves,
  findLeaf,
  splitLeaf,
  removeLeaf,
  resizeGutter,
  swapLeaves,
  replaceLeafType,
  updateLeafState,
  sanitize,
  type LayoutNode,
  type LeafNode,
  type SplitDirection
} from './layoutTree'

// Sizes for panels nested INSIDE pane components (diff list, file tree rows) —
// not part of the split tree, still persisted alongside it.
const DEFAULT_PANEL_SIZES: Record<string, number> = {
  tree: 224,
  diffList: 256
}

const HEADER_PX = 44
const STATUS_BAR_PX = 24
const ACTIVITY_BAR_PX = 44

const CENTER_TYPES = ['editor', 'diff', 'preview', 'dashboard']

function clampFraction(value: number): number {
  return Math.min(0.8, Math.max(0.1, value))
}

interface DefaultTreeOptions {
  sidebarPx?: number
  agentPx?: number
  logsPx?: number
  logsOpen?: boolean
  centerType?: string
}

// The classic Grove layout: files | [[center | agent] / logs]. Fractions are
// derived from the legacy pixel sizes so pre-tree layouts migrate cleanly.
// Exported for the base "code" view definition.
export function buildDefaultTree(options: DefaultTreeOptions = {}): LayoutNode {
  const width = window.innerWidth || 1440
  const height = window.innerHeight || 900
  const sidebarPx = options.sidebarPx ?? 256
  const agentPx = options.agentPx ?? 320
  const logsPx = options.logsPx ?? 224
  const centerType = options.centerType ?? 'editor'

  const bodyWidth = width - ACTIVITY_BAR_PX
  const sidebarFraction = clampFraction(sidebarPx / bodyWidth)
  const agentFraction = clampFraction(agentPx / (bodyWidth - sidebarPx))
  const logsFraction = clampFraction(logsPx / (height - HEADER_PX - STATUS_BAR_PX))

  const centerRow = createSplit(
    'row',
    [createLeaf(centerType), createLeaf('agent')],
    [1 - agentFraction, agentFraction]
  )
  let column: LayoutNode = centerRow
  if (options.logsOpen ?? true) {
    column = createSplit('column', [centerRow, createLeaf('logs')], [1 - logsFraction, logsFraction])
  }
  return createSplit('row', [createLeaf('files'), column], [sidebarFraction, 1 - sidebarFraction])
}

class LayoutStore {
  activeViewId = $state<string>('code')
  paneSizes = $state<Record<string, number>>({ ...DEFAULT_PANEL_SIZES })

  // Live tree per MOUNTED view. Views the user has visited stay in the DOM
  // (hidden when inactive) so switching back never remounts their panes — that
  // remount was rebuilding CodeMirror and every AgentPane message on each
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

  closeLeaf(leafId: string): void {
    if (leaves(this.tree).length <= 1) return
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

  resize(splitId: string, gutterIndex: number, deltaFraction: number, minFraction?: number): void {
    this.setActiveTree(resizeGutter(this.tree, splitId, gutterIndex, deltaFraction, minFraction))
    this.schedule()
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

  // Focus an existing pane of this type, swap it into its slot-mate's leaf,
  // or split the focused leaf as a last resort.
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
    const slot = panes.get(paneTypeId)?.slot
    const slotMate = slot ? this.slotLeaf(slot) : null
    if (slotMate) {
      this.setActiveTree(replaceLeafType(this.tree, slotMate.id, paneTypeId))
      this.focusLeafSoon(slotMate.id)
      this.schedule()
      return
    }
    this.splitFocused('row', paneTypeId)
  }

  togglePane(paneTypeId: string): void {
    const existing = leaves(this.tree).find((leaf) => leaf.paneTypeId === paneTypeId)
    if (!existing) {
      this.ensurePane(paneTypeId)
      return
    }
    this.closeLeaf(existing.id)
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
  }): void {
    this.ready = false
    this.paneSizes = { ...DEFAULT_PANEL_SIZES, ...(state.paneSizes || {}) }
    this.storedTrees = restoreViewTrees(state.viewLayouts)
    const activeId = this.restoreActiveViewId(state.activeLayoutView)
    this.activeViewId = activeId
    // Mount only the active view; others mount lazily on first switch.
    const activeTree = this.storedTrees[activeId] ?? this.initialTree(activeId, state)
    this.trees = { [activeId]: activeTree }
    this.mountedViewIds = [activeId]
    this.ready = true
  }

  private restoreActiveViewId(stored: string | null | undefined): string {
    if (stored && views.get(stored)) return stored
    return views.get('code') ? 'code' : (views.views[0]?.id ?? 'code')
  }

  private initialTree(
    viewId: string,
    state: {
      paneSizes?: Record<string, number>
      panelsOpen?: Record<string, boolean>
      centerView?: string | null
    }
  ): LayoutNode {
    // Legacy pre-tree state seeds the code view from its pixel sizes.
    const legacySizes = state.paneSizes || {}
    const hasLegacy = legacySizes.sidebar !== undefined || state.centerView
    if (viewId === 'code' && hasLegacy) {
      const centerView = state.centerView
      return buildDefaultTree({
        sidebarPx: legacySizes.sidebar,
        agentPx: legacySizes.agent,
        logsPx: legacySizes.logs,
        logsOpen: state.panelsOpen?.logs ?? true,
        centerType: centerView && CENTER_TYPES.includes(centerView) ? centerView : 'editor'
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
