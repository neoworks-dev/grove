// Pure split-tree model for the workbench layout (no runes), so it can be
// unit-tested without a Svelte/DOM runtime — same charter as keymapCore.ts.
// layout.svelte.ts owns the reactive store that wraps these operations.
//
// Every operation returns a new root; nodes are plain JSON-serializable data.
// Sizes are fractions of the parent (sum 1) so they survive window resizes.

export type SplitDirection = 'row' | 'column'

export interface LeafNode {
  kind: 'leaf'
  id: string
  paneTypeId: string
  paneState?: Record<string, unknown>
  // Pixels along the parent split's axis, for panes that hold a size instead of
  // a share of the window (the sidebar). Its siblings absorb every change
  // around it — the split's fraction for this child is then unused.
  sizePx?: number
}

export interface SplitNode {
  kind: 'split'
  id: string
  direction: SplitDirection
  children: LayoutNode[]
  sizes: number[]
}

export type LayoutNode = LeafNode | SplitNode

export const MIN_PANE_FRACTION = 0.05

// How willingly each pane changes size when a sibling opens or closes. The
// layout store builds one from the pane registry; the pure ops fall back to
// treating every pane alike, which is plain proportional redistribution.
export interface SizingPolicy {
  // Above 1 takes more of the space a closing sibling frees and gives less to
  // one that opens; below 1 does the reverse. 0 opts out of both.
  growthOf(node: LayoutNode): number
}

const PROPORTIONAL: SizingPolicy = { growthOf: () => 1 }

// Shares of `total` for the given children, weighted so panes that want to grow
// take more. `invert` flips it into how much each gives away instead.
function distribute(
  children: LayoutNode[],
  sizes: number[],
  total: number,
  policy: SizingPolicy,
  invert: boolean
): number[] {
  const weights = children.map((child, index) => {
    const growth = policy.growthOf(child)
    if (growth <= 0) return 0
    return sizes[index] * (invert ? 1 / growth : growth)
  })
  const sum = weights.reduce((running, weight) => running + weight, 0)
  // Nobody wants the space (every child opted out): fall back to even shares.
  if (sum <= 0) return children.map(() => total / children.length)
  return weights.map((weight) => (total * weight) / sum)
}

let nodeCounter = 0

function nextNodeId(prefix: 'leaf' | 'split'): string {
  nodeCounter += 1
  return `${prefix}-${nodeCounter}`
}

export function createLeaf(paneTypeId: string, paneState?: Record<string, unknown>): LeafNode {
  const leaf: LeafNode = { kind: 'leaf', id: nextNodeId('leaf'), paneTypeId }
  if (paneState) leaf.paneState = paneState
  return leaf
}

export function createSplit(
  direction: SplitDirection,
  children: LayoutNode[],
  sizes?: number[]
): SplitNode {
  return {
    kind: 'split',
    id: nextNodeId('split'),
    direction,
    children,
    sizes: sizes ? renormalize(sizes) : evenSizes(children.length)
  }
}

function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count)
}

function renormalize(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= 0) return evenSizes(sizes.length)
  return sizes.map((size) => size / total)
}

// ── Queries ─────────────────────────────────────────────────────

export function leaves(root: LayoutNode): LeafNode[] {
  if (root.kind === 'leaf') return [root]
  return root.children.flatMap(leaves)
}

export function findLeaf(root: LayoutNode, leafId: string): LeafNode | null {
  const found = leaves(root).find((leaf) => leaf.id === leafId)
  return found ?? null
}

// Ids of every node from the root down to the given leaf, inclusive. Null when
// the leaf isn't in the tree. Focus mode uses it to render just that branch.
export function pathToLeaf(root: LayoutNode, leafId: string): string[] | null {
  if (root.kind === 'leaf') {
    if (root.id !== leafId) return null
    return [root.id]
  }
  for (const child of root.children) {
    const path = pathToLeaf(child, leafId)
    if (path) return [root.id, ...path]
  }
  return null
}

export function findSplit(root: LayoutNode, splitId: string): SplitNode | null {
  if (root.kind === 'leaf') return null
  if (root.id === splitId) return root
  for (const child of root.children) {
    const found = findSplit(child, splitId)
    if (found) return found
  }
  return null
}

export function findParentSplit(root: LayoutNode, nodeId: string): SplitNode | null {
  if (root.kind === 'leaf') return null
  for (const child of root.children) {
    if (child.id === nodeId) return root
    const found = findParentSplit(child, nodeId)
    if (found) return found
  }
  return null
}

/**
 * The `flex` shorthand for each child of a split, given the pixel size those
 * children that hold one have (null for the rest).
 *
 * A split always covers its container — empty space inside one is a bug. That
 * needs two corrections: the shares are scaled so their grow factors total 1
 * (under 1, flexbox leaves the shortfall empty instead of distributing it), and
 * when every child holds a pixel size the last one gives up its own to fill
 * what is left.
 */
export function splitChildFlex(sizes: number[], fixedPx: (number | null)[]): string[] {
  const shareTotal = sizes.reduce((sum, size, index) => {
    if (fixedPx[index] !== null) return sum
    return sum + size
  }, 0)
  const fillIndex = shareTotal > 0 ? -1 : sizes.length - 1
  return sizes.map((size, index) => {
    if (index === fillIndex) return '1 1 0%'
    const px = fixedPx[index]
    if (px !== null) return `0 0 ${px}px`
    return `${size / shareTotal} 1 0%`
  })
}

// ── Transformations ─────────────────────────────────────────────

function mapLeaves(node: LayoutNode, transform: (leaf: LeafNode) => LeafNode): LayoutNode {
  if (node.kind === 'leaf') return transform(node)
  return { ...node, children: node.children.map((child) => mapLeaves(child, transform)) }
}

// Split the target leaf in the given direction. If its parent split already
// runs that direction the new leaf becomes a sibling (stealing half the
// target's fraction); otherwise the leaf is wrapped in a fresh 50/50 split.
export function splitLeaf(
  root: LayoutNode,
  leafId: string,
  direction: SplitDirection,
  newLeaf: LeafNode,
  position: 'before' | 'after' = 'after'
): LayoutNode {
  if (root.kind === 'leaf') {
    if (root.id !== leafId) return root
    return wrapInSplit(root, direction, newLeaf, position)
  }
  const index = root.children.findIndex((child) => child.kind === 'leaf' && child.id === leafId)
  if (index >= 0 && root.direction === direction) {
    return insertSibling(root, index, newLeaf, position)
  }
  const children = root.children.map((child) =>
    splitLeaf(child, leafId, direction, newLeaf, position)
  )
  return { ...root, children }
}

function wrapInSplit(
  leaf: LeafNode,
  direction: SplitDirection,
  newLeaf: LeafNode,
  position: 'before' | 'after'
): SplitNode {
  const children = position === 'before' ? [newLeaf, leaf] : [leaf, newLeaf]
  return createSplit(direction, children, [0.5, 0.5])
}

function insertSibling(
  split: SplitNode,
  index: number,
  newLeaf: LeafNode,
  position: 'before' | 'after'
): SplitNode {
  const children = [...split.children]
  const sizes = [...split.sizes]
  const half = sizes[index] / 2
  sizes[index] = half
  const insertAt = position === 'before' ? index : index + 1
  children.splice(insertAt, 0, newLeaf)
  sizes.splice(insertAt, 0, half)
  return { ...split, children, sizes }
}

// The outer edges of the whole tree a pane can be pinned against.
export type EdgeSide = 'left' | 'right' | 'top' | 'bottom'

// Insert a leaf against one outer edge of the tree, taking `fraction` of the
// root's extent from the panes already there. This is how a pane that declares
// a preferred edge (the sidebar family, the agent panel) comes back after being
// closed or dragged elsewhere — it returns to its edge, not beside whatever
// happens to be focused.
export function insertAtEdge(
  root: LayoutNode,
  leaf: LeafNode,
  edge: EdgeSide,
  fraction: number,
  policy: SizingPolicy = PROPORTIONAL
): LayoutNode {
  const direction: SplitDirection = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const atStart = edge === 'left' || edge === 'top'
  const size = Math.min(0.5, Math.max(MIN_PANE_FRACTION, fraction))
  if (root.kind !== 'split' || root.direction !== direction) {
    const children = atStart ? [leaf, root] : [root, leaf]
    const sizes = atStart ? [size, 1 - size] : [1 - size, size]
    return createSplit(direction, children, sizes)
  }
  // The panes already there pay for the newcomer, the readiest to shrink first.
  const given = distribute(root.children, root.sizes, size, policy, true)
  const children = [...root.children]
  const sizes = root.sizes.map((existing, index) =>
    Math.max(MIN_PANE_FRACTION, existing - given[index])
  )
  const insertAt = atStart ? 0 : children.length
  children.splice(insertAt, 0, leaf)
  sizes.splice(insertAt, 0, size)
  return { ...root, children, sizes: renormalize(sizes) }
}

// Remove a leaf, redistributing its fraction proportionally and collapsing
// single-child splits. Returns null when the last leaf was removed — the
// caller substitutes its fallback tree.
export function removeLeaf(
  root: LayoutNode,
  leafId: string,
  policy: SizingPolicy = PROPORTIONAL
): LayoutNode | null {
  if (root.kind === 'leaf') {
    if (root.id === leafId) return null
    return root
  }
  const children: LayoutNode[] = []
  const sizes: number[] = []
  let freed = 0
  root.children.forEach((child, index) => {
    const kept = removeLeaf(child, leafId, policy)
    if (!kept) {
      freed += root.sizes[index]
      return
    }
    children.push(kept)
    sizes.push(root.sizes[index])
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  // The panes left behind split the vacated space, the keenest to grow first.
  const taken = distribute(children, sizes, freed, policy, false)
  return {
    ...root,
    children,
    sizes: renormalize(sizes.map((size, index) => size + taken[index]))
  }
}

// Adjust the boundary between children gutterIndex and gutterIndex+1 of the
// target split. Delta is a fraction of the split; both sides stay above min.
export function resizeGutter(
  root: LayoutNode,
  splitId: string,
  gutterIndex: number,
  deltaFraction: number,
  minFraction: number = MIN_PANE_FRACTION
): LayoutNode {
  if (root.kind === 'leaf') return root
  if (root.id !== splitId) {
    const children = root.children.map((child) =>
      resizeGutter(child, splitId, gutterIndex, deltaFraction, minFraction)
    )
    return { ...root, children }
  }
  const before = root.sizes[gutterIndex]
  const after = root.sizes[gutterIndex + 1]
  if (before === undefined || after === undefined) return root
  const lowest = minFraction - before
  const highest = after - minFraction
  if (lowest > highest) return root
  const clamped = Math.min(Math.max(deltaFraction, lowest), highest)
  const sizes = [...root.sizes]
  sizes[gutterIndex] = before + clamped
  sizes[gutterIndex + 1] = after - clamped
  return { ...root, sizes }
}

// Swap the positions of two leaves (used for directional move).
export function swapLeaves(root: LayoutNode, firstId: string, secondId: string): LayoutNode {
  const first = findLeaf(root, firstId)
  const second = findLeaf(root, secondId)
  if (!first || !second) return root
  return mapLeaves(root, (leaf) => {
    if (leaf.id === firstId) return second
    if (leaf.id === secondId) return first
    return leaf
  })
}

export function replaceLeafType(
  root: LayoutNode,
  leafId: string,
  paneTypeId: string,
  paneState?: Record<string, unknown>
): LayoutNode {
  return mapLeaves(root, (leaf) => {
    if (leaf.id !== leafId) return leaf
    const next: LeafNode = { kind: 'leaf', id: leaf.id, paneTypeId }
    if (paneState) next.paneState = paneState
    // The window keeps the size the user gave it when its content is swapped —
    // picking another sidebar view must not resize the sidebar.
    if (typeof leaf.sizePx === 'number') next.sizePx = leaf.sizePx
    return next
  })
}

// Set (or with null clear) the pixel size a leaf holds along its parent's axis.
export function setLeafSizePx(root: LayoutNode, leafId: string, px: number | null): LayoutNode {
  return mapLeaves(root, (leaf) => {
    if (leaf.id !== leafId) return leaf
    if (px === null) {
      const { sizePx: _cleared, ...rest } = leaf
      return rest
    }
    return { ...leaf, sizePx: px }
  })
}

// Where a dragged pane lands relative to the target leaf: its middle swaps
// places with the target; an edge splits the target and drops the pane on that
// side.
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom'

// Move `draggedId` onto `targetId` at the given zone. Center swaps the two
// leaves; an edge removes the dragged leaf and inserts it beside the target as
// a split. The dragged leaf node keeps its id and state so its pane follows the
// move. Returns the root unchanged when the move is a no-op or invalid (same
// leaf, missing leaf, or dragging away the last pane).
export function moveLeaf(
  root: LayoutNode,
  draggedId: string,
  targetId: string,
  zone: DropZone,
  policy: SizingPolicy = PROPORTIONAL
): LayoutNode {
  if (draggedId === targetId) return root
  const dragged = findLeaf(root, draggedId)
  if (!dragged || !findLeaf(root, targetId)) return root
  if (zone === 'center') {
    return normalize(swapLeaves(root, draggedId, targetId))
  }
  const withoutDragged = removeLeaf(root, draggedId, policy)
  if (!withoutDragged || !findLeaf(withoutDragged, targetId)) return root
  const direction: SplitDirection = zone === 'left' || zone === 'right' ? 'row' : 'column'
  const position = zone === 'left' || zone === 'top' ? 'before' : 'after'
  return normalize(splitLeaf(withoutDragged, targetId, direction, dragged, position))
}

export function updateLeafState(
  root: LayoutNode,
  leafId: string,
  patch: Record<string, unknown>
): LayoutNode {
  return mapLeaves(root, (leaf) => {
    if (leaf.id !== leafId) return leaf
    return { ...leaf, paneState: { ...leaf.paneState, ...patch } }
  })
}

// ── Normalization + deserialization ─────────────────────────────

// Merge nested same-direction splits, collapse single-child splits, and
// renormalize sizes so they sum to 1.
export function normalize(root: LayoutNode): LayoutNode {
  if (root.kind === 'leaf') return root
  const children: LayoutNode[] = []
  const sizes: number[] = []
  root.children.forEach((child, index) => {
    const normalized = normalize(child)
    if (normalized.kind === 'split' && normalized.direction === root.direction) {
      mergeSameDirection(normalized, root.sizes[index], children, sizes)
      return
    }
    children.push(normalized)
    sizes.push(root.sizes[index])
  })
  if (children.length === 1) return children[0]
  return { ...root, children, sizes: renormalize(sizes) }
}

function mergeSameDirection(
  split: SplitNode,
  parentFraction: number,
  children: LayoutNode[],
  sizes: number[]
): void {
  split.children.forEach((grandchild, index) => {
    children.push(grandchild)
    sizes.push(parentFraction * split.sizes[index])
  })
}

// Validate a deserialized tree. Malformed nodes are dropped; leaves with
// unknown pane types are KEPT (a plugin may register the type later — the
// renderer shows a placeholder until then). Duplicate ids are reassigned.
// Returns null when nothing usable remains so the caller falls back to the
// view's default tree.
export function sanitize(value: unknown): LayoutNode | null {
  const seenIds = new Set<string>()
  const node = sanitizeNode(value, seenIds)
  if (!node) return null
  return normalize(node)
}

function sanitizeNode(value: unknown, seenIds: Set<string>): LayoutNode | null {
  if (!value || typeof value !== 'object') return null
  const node = value as Record<string, unknown>
  if (node.kind === 'leaf') return sanitizeLeaf(node, seenIds)
  if (node.kind === 'split') return sanitizeSplit(node, seenIds)
  return null
}

function sanitizeLeaf(node: Record<string, unknown>, seenIds: Set<string>): LeafNode | null {
  if (typeof node.paneTypeId !== 'string' || node.paneTypeId.length === 0) return null
  const leaf: LeafNode = {
    kind: 'leaf',
    id: claimId(node.id, 'leaf', seenIds),
    paneTypeId: node.paneTypeId
  }
  if (node.paneState && typeof node.paneState === 'object' && !Array.isArray(node.paneState)) {
    leaf.paneState = node.paneState as Record<string, unknown>
  }
  if (typeof node.sizePx === 'number' && Number.isFinite(node.sizePx) && node.sizePx > 0) {
    leaf.sizePx = node.sizePx
  }
  return leaf
}

function sanitizeSplit(node: Record<string, unknown>, seenIds: Set<string>): LayoutNode | null {
  if (node.direction !== 'row' && node.direction !== 'column') return null
  if (!Array.isArray(node.children)) return null
  const children: LayoutNode[] = []
  const sizes: number[] = []
  const rawSizes = Array.isArray(node.sizes) ? node.sizes : []
  node.children.forEach((rawChild, index) => {
    const child = sanitizeNode(rawChild, seenIds)
    if (!child) return
    children.push(child)
    sizes.push(sanitizeSize(rawSizes[index]))
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return {
    kind: 'split',
    id: claimId(node.id, 'split', seenIds),
    direction: node.direction,
    children,
    sizes: renormalize(sizes)
  }
}

function sanitizeSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value
}

function claimId(value: unknown, prefix: 'leaf' | 'split', seenIds: Set<string>): string {
  const usable = typeof value === 'string' && value.length > 0 && !seenIds.has(value)
  if (!usable) {
    const fresh = nextNodeId(prefix)
    seenIds.add(fresh)
    return fresh
  }
  const id = value as string
  reserveGeneratedId(id)
  seenIds.add(id)
  return id
}

// Keep the generator ahead of every id restored from disk. The counter restarts
// at zero each launch, so without this a pane created after a restore (an edge
// pane returning, a new split) would be handed an id a restored leaf already
// holds — and two leaves sharing an id collapse into one in the keyed render.
function reserveGeneratedId(id: string): void {
  const match = /^(?:leaf|split)-(\d+)$/.exec(id)
  if (!match) return
  nodeCounter = Math.max(nodeCounter, Number(match[1]))
}
