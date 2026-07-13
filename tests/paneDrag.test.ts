import { expect, test } from 'bun:test'
import { dropZoneAt, placeholderRect, type Rect } from '../src/renderer/src/lib/paneDragCore'
import {
  createLeaf,
  createSplit,
  findLeaf,
  findParentSplit,
  leaves,
  moveLeaf,
  type LayoutNode,
  type SplitNode
} from '../src/renderer/src/lib/layoutTree'

// ── Geometry ──────────────────────────────────────────────────────
test('dropZoneAt: middle is center', () => {
  expect(dropZoneAt(0.5, 0.5)).toBe('center')
})

test('dropZoneAt: edges pick the nearest side', () => {
  expect(dropZoneAt(0.05, 0.5)).toBe('left')
  expect(dropZoneAt(0.95, 0.5)).toBe('right')
  expect(dropZoneAt(0.5, 0.05)).toBe('top')
  expect(dropZoneAt(0.5, 0.95)).toBe('bottom')
})

test('dropZoneAt: near a corner resolves to the closest edge', () => {
  // Slightly closer to the top than the left.
  expect(dropZoneAt(0.2, 0.1)).toBe('top')
})

const rect: Rect = { left: 100, top: 50, width: 400, height: 200 }

test('placeholderRect: center fills the pane', () => {
  expect(placeholderRect(rect, 'center')).toEqual(rect)
})

test('placeholderRect: halves', () => {
  expect(placeholderRect(rect, 'left')).toEqual({ left: 100, top: 50, width: 200, height: 200 })
  expect(placeholderRect(rect, 'right')).toEqual({ left: 300, top: 50, width: 200, height: 200 })
  expect(placeholderRect(rect, 'top')).toEqual({ left: 100, top: 50, width: 400, height: 100 })
  expect(placeholderRect(rect, 'bottom')).toEqual({ left: 100, top: 150, width: 400, height: 100 })
})

// ── Tree moves ────────────────────────────────────────────────────
function twoPaneRow(): { tree: SplitNode; a: string; b: string } {
  const a = createLeaf('editor')
  const b = createLeaf('agent')
  return { tree: createSplit('row', [a, b]), a: a.id, b: b.id }
}

test('center drop swaps the two panes', () => {
  const a = createLeaf('editor')
  const b = createLeaf('agent')
  const tree = createSplit('row', [a, b])
  const next = moveLeaf(tree, a.id, b.id, 'center')
  // Both panes survive; their positions (pane types) trade places.
  const row = next as SplitNode
  expect(row.children.map((child) => (child as { id: string }).id)).toEqual([b.id, a.id])
  expect(leaves(next).map((leaf) => leaf.paneTypeId)).toEqual(['agent', 'editor'])
})

test('edge drop splits the target in the matching direction', () => {
  const { tree, a, b } = twoPaneRow()
  // Drag A onto B's bottom → B becomes a column split with A after it.
  const next = moveLeaf(tree, a, b, 'bottom')
  const parent = findParentSplit(next, b) as SplitNode
  expect(parent.direction).toBe('column')
  expect(parent.children.map((child) => (child as { id: string }).id)).toEqual([b, a])
})

test('left edge inserts the dragged leaf before the target as a row', () => {
  const { tree, a, b } = twoPaneRow()
  // Drag B onto A's left.
  const next = moveLeaf(tree, b, a, 'left')
  const parent = findParentSplit(next, a) as SplitNode
  expect(parent.direction).toBe('row')
  expect(parent.children.map((child) => (child as { id: string }).id)).toEqual([b, a])
})

test('dropping a leaf onto itself is a no-op', () => {
  const { tree, a } = twoPaneRow()
  expect(moveLeaf(tree, a, a, 'center')).toBe(tree)
})

test('moved leaf keeps its id and pane state', () => {
  const a = createLeaf('nvim', { cursor: 5 })
  const b = createLeaf('agent')
  const tree: LayoutNode = createSplit('row', [a, b])
  const next = moveLeaf(tree, a.id, b.id, 'top')
  const moved = findLeaf(next, a.id)
  expect(moved?.paneTypeId).toBe('nvim')
  expect(moved?.paneState).toEqual({ cursor: 5 })
})
