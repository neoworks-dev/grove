import { describe, it, expect } from 'bun:test'
import {
  createLeaf,
  createSplit,
  leaves,
  findLeaf,
  findParentSplit,
  splitLeaf,
  removeLeaf,
  resizeGutter,
  swapLeaves,
  replaceLeafType,
  updateLeafState,
  normalize,
  sanitize,
  type LayoutNode,
  type SplitNode
} from '../src/renderer/src/lib/layoutTree'

function sum(sizes: number[]): number {
  return sizes.reduce((total, size) => total + size, 0)
}

describe('splitLeaf', () => {
  it('wraps a lone leaf in a 50/50 split', () => {
    const editor = createLeaf('editor')
    const diff = createLeaf('diff')
    const root = splitLeaf(editor, editor.id, 'row', diff)
    expect(root.kind).toBe('split')
    const split = root as SplitNode
    expect(split.direction).toBe('row')
    expect(split.children.map((child) => (child as { paneTypeId: string }).paneTypeId)).toEqual([
      'editor',
      'diff'
    ])
    expect(split.sizes).toEqual([0.5, 0.5])
  })

  it('inserts a sibling into a same-direction parent, stealing half the fraction', () => {
    const a = createLeaf('a')
    const b = createLeaf('b')
    const root = createSplit('row', [a, b], [0.6, 0.4])
    const c = createLeaf('c')
    const next = splitLeaf(root, a.id, 'row', c) as SplitNode
    expect(next.children).toHaveLength(3)
    expect(leaves(next).map((leaf) => leaf.paneTypeId)).toEqual(['a', 'c', 'b'])
    expect(next.sizes[0]).toBeCloseTo(0.3)
    expect(next.sizes[1]).toBeCloseTo(0.3)
    expect(next.sizes[2]).toBeCloseTo(0.4)
  })

  it('nests a cross-direction split', () => {
    const a = createLeaf('a')
    const b = createLeaf('b')
    const root = createSplit('row', [a, b])
    const c = createLeaf('c')
    const next = splitLeaf(root, a.id, 'column', c) as SplitNode
    expect(next.direction).toBe('row')
    const nested = next.children[0] as SplitNode
    expect(nested.kind).toBe('split')
    expect(nested.direction).toBe('column')
    expect(leaves(nested).map((leaf) => leaf.paneTypeId)).toEqual(['a', 'c'])
  })

  it('supports inserting before the target', () => {
    const a = createLeaf('a')
    const b = createLeaf('b')
    const root = splitLeaf(a, a.id, 'row', b, 'before') as SplitNode
    expect(leaves(root).map((leaf) => leaf.paneTypeId)).toEqual(['b', 'a'])
  })
})

describe('removeLeaf', () => {
  it('redistributes the freed fraction proportionally', () => {
    const a = createLeaf('a')
    const b = createLeaf('b')
    const c = createLeaf('c')
    const root = createSplit('row', [a, b, c], [0.5, 0.25, 0.25])
    const next = removeLeaf(root, a.id) as SplitNode
    expect(next.children).toHaveLength(2)
    expect(next.sizes[0]).toBeCloseTo(0.5)
    expect(next.sizes[1]).toBeCloseTo(0.5)
    expect(sum(next.sizes)).toBeCloseTo(1)
  })

  it('collapses a single-child split', () => {
    const a = createLeaf('a')
    const b = createLeaf('b')
    const root = createSplit('row', [a, b])
    const next = removeLeaf(root, b.id)
    expect(next).toBe(a)
  })

  it('returns null when the last leaf is removed', () => {
    const a = createLeaf('a')
    expect(removeLeaf(a, a.id)).toBeNull()
  })

  it('collapses through nested splits', () => {
    const a = createLeaf('a')
    const b = createLeaf('b')
    const c = createLeaf('c')
    const inner = createSplit('column', [b, c])
    const root = createSplit('row', [a, inner])
    const next = removeLeaf(root, c.id) as SplitNode
    expect(next.kind).toBe('split')
    expect(leaves(next).map((leaf) => leaf.paneTypeId)).toEqual(['a', 'b'])
    expect(next.children[1]).toBe(b)
  })
})

describe('resizeGutter', () => {
  it('shifts fraction between the two adjacent children', () => {
    const root = createSplit('row', [createLeaf('a'), createLeaf('b')], [0.5, 0.5])
    const next = resizeGutter(root, root.id, 0, 0.1) as SplitNode
    expect(next.sizes[0]).toBeCloseTo(0.6)
    expect(next.sizes[1]).toBeCloseTo(0.4)
  })

  it('clamps so both sides stay above the minimum', () => {
    const root = createSplit('row', [createLeaf('a'), createLeaf('b')], [0.5, 0.5])
    const next = resizeGutter(root, root.id, 0, 0.9, 0.1) as SplitNode
    expect(next.sizes[0]).toBeCloseTo(0.9)
    expect(next.sizes[1]).toBeCloseTo(0.1)
  })

  it('reaches nested splits by id', () => {
    const inner = createSplit('column', [createLeaf('a'), createLeaf('b')], [0.5, 0.5])
    const root = createSplit('row', [createLeaf('c'), inner])
    const next = resizeGutter(root, inner.id, 0, -0.2) as SplitNode
    const nested = next.children[1] as SplitNode
    expect(nested.sizes[0]).toBeCloseTo(0.3)
    expect(nested.sizes[1]).toBeCloseTo(0.7)
  })
})

describe('swapLeaves / replaceLeafType / updateLeafState', () => {
  it('swaps two leaf positions', () => {
    const a = createLeaf('a')
    const b = createLeaf('b')
    const root = createSplit('row', [a, b])
    const next = swapLeaves(root, a.id, b.id) as SplitNode
    expect(leaves(next).map((leaf) => leaf.paneTypeId)).toEqual(['b', 'a'])
  })

  it('replaces a leaf pane type in place, dropping stale state', () => {
    const a = createLeaf('a', { openPath: 'x.ts' })
    const next = replaceLeafType(a, a.id, 'b')
    expect(findLeaf(next, a.id)?.paneTypeId).toBe('b')
    expect(findLeaf(next, a.id)?.paneState).toBeUndefined()
  })

  it('merges a state patch into a leaf', () => {
    const a = createLeaf('a', { keep: 1 })
    const next = updateLeafState(a, a.id, { added: 2 })
    expect(findLeaf(next, a.id)?.paneState).toEqual({ keep: 1, added: 2 })
  })
})

describe('normalize', () => {
  it('merges nested same-direction splits with combined fractions', () => {
    const inner = createSplit('row', [createLeaf('b'), createLeaf('c')], [0.5, 0.5])
    const root = createSplit('row', [createLeaf('a'), inner], [0.5, 0.5])
    const next = normalize(root) as SplitNode
    expect(next.children).toHaveLength(3)
    expect(next.sizes[0]).toBeCloseTo(0.5)
    expect(next.sizes[1]).toBeCloseTo(0.25)
    expect(next.sizes[2]).toBeCloseTo(0.25)
  })

  it('keeps cross-direction nesting intact', () => {
    const inner = createSplit('column', [createLeaf('b'), createLeaf('c')])
    const root = createSplit('row', [createLeaf('a'), inner])
    const next = normalize(root) as SplitNode
    expect(next.children).toHaveLength(2)
    expect((next.children[1] as SplitNode).direction).toBe('column')
  })
})

describe('sanitize', () => {
  it('round-trips a valid serialized tree', () => {
    const root = createSplit('row', [createLeaf('editor'), createLeaf('agent')], [0.7, 0.3])
    const restored = sanitize(JSON.parse(JSON.stringify(root))) as SplitNode
    expect(restored.kind).toBe('split')
    expect(leaves(restored).map((leaf) => leaf.paneTypeId)).toEqual(['editor', 'agent'])
    expect(restored.sizes[0]).toBeCloseTo(0.7)
  })

  it('keeps leaves with unknown pane types', () => {
    const tree = sanitize({
      kind: 'split',
      id: 's',
      direction: 'row',
      children: [
        { kind: 'leaf', id: 'a', paneTypeId: 'editor' },
        { kind: 'leaf', id: 'b', paneTypeId: 'plugin:not-installed.panel' }
      ],
      sizes: [0.5, 0.5]
    }) as SplitNode
    expect(leaves(tree).map((leaf) => leaf.paneTypeId)).toContain('plugin:not-installed.panel')
  })

  it('drops malformed nodes and renormalizes sizes', () => {
    const tree = sanitize({
      kind: 'split',
      id: 's',
      direction: 'row',
      children: [
        { kind: 'leaf', id: 'a', paneTypeId: 'editor' },
        { kind: 'nonsense' },
        { kind: 'leaf', id: 'b', paneTypeId: 'agent' }
      ],
      sizes: [2, 1, 2]
    }) as SplitNode
    expect(tree.children).toHaveLength(2)
    expect(sum(tree.sizes)).toBeCloseTo(1)
  })

  it('reassigns duplicate ids', () => {
    const tree = sanitize({
      kind: 'split',
      id: 's',
      direction: 'row',
      children: [
        { kind: 'leaf', id: 'dup', paneTypeId: 'a' },
        { kind: 'leaf', id: 'dup', paneTypeId: 'b' }
      ],
      sizes: [0.5, 0.5]
    }) as SplitNode
    const ids = leaves(tree).map((leaf) => leaf.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('returns null for unrecoverable input', () => {
    expect(sanitize(null)).toBeNull()
    expect(sanitize('garbage')).toBeNull()
    expect(sanitize({ kind: 'split', direction: 'row', children: [], sizes: [] })).toBeNull()
    expect(sanitize({ kind: 'leaf', id: 'x' })).toBeNull()
  })

  it('collapses a split that sanitizes down to one child', () => {
    const tree = sanitize({
      kind: 'split',
      id: 's',
      direction: 'row',
      children: [{ kind: 'leaf', id: 'a', paneTypeId: 'editor' }, { bad: true }],
      sizes: [0.5, 0.5]
    }) as LayoutNode
    expect(tree.kind).toBe('leaf')
  })
})

describe('findParentSplit', () => {
  it('finds the direct parent of a nested leaf', () => {
    const b = createLeaf('b')
    const inner = createSplit('column', [b, createLeaf('c')])
    const root = createSplit('row', [createLeaf('a'), inner])
    expect(findParentSplit(root, b.id)?.id).toBe(inner.id)
    expect(findParentSplit(root, inner.id)?.id).toBe(root.id)
    expect(findParentSplit(root, 'missing')).toBeNull()
  })
})
