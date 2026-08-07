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

export function findParentSplit(root: LayoutNode, nodeId: string): SplitNode | null {
  if (root.kind === 'leaf') return null
  for (const child of root.children) {
    if (child.id === nodeId) return root
    const found = findParentSplit(child, nodeId)
    if (found) return found
  }
  return null
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

// Remove a leaf, redistributing its fraction proportionally and collapsing
// single-child splits. Returns null when the last leaf was removed — the
// caller substitutes its fallback tree.
export function removeLeaf(root: LayoutNode, leafId: string): LayoutNode | null {
  if (root.kind === 'leaf') {
    if (root.id === leafId) return null
    return root
  }
  const children: LayoutNode[] = []
  const sizes: number[] = []
  root.children.forEach((child, index) => {
    const kept = removeLeaf(child, leafId)
    if (!kept) return
    children.push(kept)
    sizes.push(root.sizes[index])
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...root, children, sizes: renormalize(sizes) }
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
    return next
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
  zone: DropZone
): LayoutNode {
  if (draggedId === targetId) return root
  const dragged = findLeaf(root, draggedId)
  if (!dragged || !findLeaf(root, targetId)) return root
  if (zone === 'center') {
    return normalize(swapLeaves(root, draggedId, targetId))
  }
  const withoutDragged = removeLeaf(root, draggedId)
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
  const leaf: LeafNode = { kind: 'leaf', id: claimId(node.id, 'leaf', seenIds), paneTypeId: node.paneTypeId }
  if (node.paneState && typeof node.paneState === 'object' && !Array.isArray(node.paneState)) {
    leaf.paneState = node.paneState as Record<string, unknown>
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
  const id = usable ? (value as string) : nextNodeId(prefix)
  seenIds.add(id)
  return id
}
