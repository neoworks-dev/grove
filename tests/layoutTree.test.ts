import { describe, it, expect } from 'bun:test'
import {
  createLeaf,
  createSplit,
  leaves,
  findLeaf,
  findParentSplit,
  insertAtEdge,
  paneTypesInSlot,
  pathToLeaf,
  splitChildFlex,
  splitLeaf,
  removeLeaf,
  removeLeafInto,
  resizeGutter,
  clampGutterShift,
  swapLeaves,
  syncNvimWindowLeaves,
  replaceLeafType,
  setLeafSizePx,
  updateLeafState,
  normalize,
  sanitize,
  type LayoutNode,
  type LeafNode,
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

  it('lets a side the layout squeezed under the minimum grow back', () => {
    const root = createSplit('row', [createLeaf('a'), createLeaf('b')], [0.95, 0.05])
    const next = resizeGutter(root, root.id, 0, -0.1, 0.1) as SplitNode
    expect(next.sizes[0]).toBeCloseTo(0.85)
    expect(next.sizes[1]).toBeCloseTo(0.15)
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

describe('clampGutterShift', () => {
  it('passes a shift both sides can take', () => {
    expect(clampGutterShift(0.1, 0.5, 0.5, 0.1, 0.1)).toBeCloseTo(0.1)
  })

  it('stops a side at the minimum', () => {
    expect(clampGutterShift(0.5, 0.5, 0.5, 0.1, 0.1)).toBeCloseTo(0.4)
  })

  it('stops each side at its own minimum, not the larger of the two', () => {
    // The left side needs 0.4, the right only 0.1: the right may shrink to 0.1.
    expect(clampGutterShift(0.3, 0.5, 0.5, 0.4, 0.1)).toBeCloseTo(0.3)
    expect(clampGutterShift(0.5, 0.5, 0.5, 0.4, 0.1)).toBeCloseTo(0.4)
    expect(clampGutterShift(-0.5, 0.5, 0.5, 0.4, 0.1)).toBeCloseTo(-0.1)
  })

  it('never moves the gutter for a side that is already under the minimum', () => {
    // b sits at 0.05 with a 0.1 minimum: growing it is free, shrinking it is not.
    expect(clampGutterShift(-0.02, 0.95, 0.05, 0.1, 0.1)).toBeCloseTo(-0.02)
    expect(clampGutterShift(0.02, 0.95, 0.05, 0.1, 0.1)).toBe(0)
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

describe('insertAtEdge', () => {
  it('wraps a lone leaf so the new pane sits on the given edge', () => {
    const editor = createLeaf('editor')
    const root = insertAtEdge(editor, createLeaf('files'), 'left', 0.2) as SplitNode
    expect(root.direction).toBe('row')
    expect((root.children[0] as LeafNode).paneTypeId).toBe('files')
    expect(root.sizes[0]).toBeCloseTo(0.2)
    expect(sum(root.sizes)).toBeCloseTo(1)
  })

  it('joins an existing split of the same axis instead of nesting', () => {
    const root = createSplit('row', [createLeaf('files'), createLeaf('editor')], [0.2, 0.8])
    const next = insertAtEdge(root, createLeaf('agent'), 'right', 0.25) as SplitNode
    expect(next.children).toHaveLength(3)
    expect((next.children[2] as LeafNode).paneTypeId).toBe('agent')
    // The panes already there give up their share proportionally.
    expect(next.sizes[0] / next.sizes[1]).toBeCloseTo(0.25)
    expect(sum(next.sizes)).toBeCloseTo(1)
  })

  it('nests when the edge runs across the root split', () => {
    const root = createSplit('row', [createLeaf('files'), createLeaf('editor')])
    const next = insertAtEdge(root, createLeaf('terminal'), 'bottom', 0.3) as SplitNode
    expect(next.direction).toBe('column')
    expect(next.children[0].kind).toBe('split')
    expect((next.children[1] as LeafNode).paneTypeId).toBe('terminal')
  })

  it('never lets an edge pane take more than half the tree', () => {
    const root = insertAtEdge(createLeaf('editor'), createLeaf('files'), 'left', 0.9) as SplitNode
    expect(root.sizes[0]).toBeCloseTo(0.5)
  })
})

describe('pathToLeaf', () => {
  it('returns every node from the root down to the leaf', () => {
    const target = createLeaf('editor')
    const inner = createSplit('column', [target, createLeaf('terminal')])
    const root = createSplit('row', [createLeaf('files'), inner])
    expect(pathToLeaf(root, target.id)).toEqual([root.id, inner.id, target.id])
  })

  it('returns null for a leaf that is not in the tree', () => {
    expect(pathToLeaf(createLeaf('editor'), 'missing')).toBeNull()
  })
})

describe('id generation after a restore', () => {
  it('never hands a new node an id a restored node already holds', () => {
    const restored = sanitize({
      kind: 'split',
      id: 'split-40',
      direction: 'row',
      children: [
        { kind: 'leaf', id: 'leaf-41', paneTypeId: 'files' },
        { kind: 'leaf', id: 'leaf-42', paneTypeId: 'editor' }
      ],
      sizes: [0.2, 0.8]
    }) as SplitNode
    const fresh = createLeaf('agent')
    const ids = leaves(insertAtEdge(restored, fresh, 'right', 0.25)).map((leaf) => leaf.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('sizing policy', () => {
  // The editor grows first, the agent panel yields first, the sidebar does
  // neither — the same weights the pane registry hands the layout store.
  const policy = {
    growthOf(node: LayoutNode): number {
      if (node.kind !== 'leaf') return 1
      const growth: Record<string, number> = { editor: 2, agent: 0.5, files: 0 }
      return growth[node.paneTypeId] ?? 1
    }
  }

  function tree(): SplitNode {
    return createSplit(
      'row',
      [createLeaf('files'), createLeaf('editor'), createLeaf('agent')],
      [0.2, 0.5, 0.3]
    )
  }

  it("gives a closing pane's space to the pane keenest to grow", () => {
    const root = tree()
    const agent = root.children[2] as LeafNode
    const next = removeLeaf(root, agent.id, policy) as SplitNode
    const [filesSize, editorSize] = next.sizes
    // The sidebar opted out, so the editor takes all 0.3 and is renormalized.
    expect(filesSize).toBeCloseTo(0.2)
    expect(editorSize).toBeCloseTo(0.8)
  })

  it('takes space for a new pane from the pane readiest to shrink', () => {
    const next = insertAtEdge(tree(), createLeaf('terminal'), 'right', 0.2, policy) as SplitNode
    const [filesSize, editorSize, agentSize] = next.sizes
    expect(filesSize).toBeCloseTo(0.2)
    // The agent gives up more than the editor despite starting smaller.
    expect(0.3 - agentSize).toBeGreaterThan(0.5 - editorSize)
  })

  it('leaves a fixed pane alone in both directions', () => {
    const root = tree()
    const grown = removeLeaf(root, (root.children[2] as LeafNode).id, policy) as SplitNode
    const shrunk = insertAtEdge(root, createLeaf('terminal'), 'right', 0.2, policy) as SplitNode
    expect(grown.sizes[0]).toBeCloseTo(shrunk.sizes[0])
  })
})

describe('fixed pane sizes', () => {
  it('keeps the pixel size when the pane type is swapped', () => {
    const sidebar = { ...createLeaf('files'), sizePx: 300 }
    const root = createSplit('row', [sidebar, createLeaf('editor')], [0.2, 0.8])
    const next = replaceLeafType(root, sidebar.id, 'changes') as SplitNode
    expect((next.children[0] as LeafNode).sizePx).toBe(300)
  })

  it('round-trips through sanitize and can be cleared', () => {
    const root = setLeafSizePx(createLeaf('files'), 'nope', 240)
    const sized = setLeafSizePx(root, root.id, 240) as LeafNode
    expect(sized.sizePx).toBe(240)
    expect((sanitize(sized) as LeafNode).sizePx).toBe(240)
    expect((setLeafSizePx(sized, sized.id, null) as LeafNode).sizePx).toBeUndefined()
  })
})

describe('splitChildFlex', () => {
  // The grow factors of the children sharing the container have to total 1.
  // Under 1, flexbox hands out only that fraction of the free space and leaves
  // the rest of the split empty.
  function growTotal(flex: string[]): number {
    return flex
      .filter((value) => value.endsWith('0%'))
      .reduce((sum, value) => sum + Number(value.split(' ')[0]), 0)
  }

  it('fills the split when a fixed pane sits among shares', () => {
    const flex = splitChildFlex([0.05, 0.68, 0.27], [319, null, null])
    expect(flex[0]).toBe('0 0 319px')
    expect(growTotal(flex)).toBeCloseTo(1)
  })

  it('keeps the shares in proportion to each other', () => {
    const flex = splitChildFlex([0.05, 0.68, 0.27], [319, null, null])
    const [, editor, agent] = flex.map((value) => Number(value.split(' ')[0]))
    expect(editor / agent).toBeCloseTo(0.68 / 0.27)
  })

  it('fills the split with the last pane when every child is fixed', () => {
    const flex = splitChildFlex([0.5, 0.5], [256, 256])
    expect(flex[0]).toBe('0 0 256px')
    expect(flex[1]).toBe('1 1 0%')
  })

  it('leaves a split of plain shares alone', () => {
    const flex = splitChildFlex([0.3, 0.7], [null, null])
    expect(growTotal(flex)).toBeCloseTo(1)
    expect(Number(flex[0].split(' ')[0])).toBeCloseTo(0.3)
  })
})

// A named view is its centre pane: the GitHub view is the GitHub pane. Grove
// uses this both to refuse letting another centre pane replace it, and to drop
// a saved layout that no longer holds it.
describe('paneTypesInSlot', () => {
  const SLOTS: Record<string, string> = {
    nvim: 'center',
    github: 'center',
      agent: 'center',
    files: 'sidebar'
  }

  function slotOf(paneTypeId: string): string | undefined {
    return SLOTS[paneTypeId]
  }

  it('reports a single-pane view as that pane', () => {
    expect(paneTypesInSlot(createLeaf('github'), 'center', slotOf)).toEqual(['github'])
  })

  it('leaves out panes of another slot', () => {
    const tree = createSplit('row', [createLeaf('files'), createLeaf('nvim')])
    expect(paneTypesInSlot(tree, 'center', slotOf)).toEqual(['nvim'])
  })

  it('lists each type once, in tree order', () => {
    const tree = createSplit('row', [createLeaf('nvim'), createLeaf('agent'), createLeaf('nvim')])
    expect(paneTypesInSlot(tree, 'center', slotOf)).toEqual(['nvim', 'agent'])
  })

  it('ignores a pane type that belongs to no slot', () => {
    const tree = createSplit('row', [createLeaf('github'), createLeaf('not-a-pane')])
    expect(paneTypesInSlot(tree, 'center', slotOf)).toEqual(['github'])
  })

  it('tells a view that lost its own pane from one the user merely split', () => {
    // The bug: opening a file while the GitHub view was active replaced its
    // only leaf with the editor, and that layout was then persisted.
    const centre = paneTypesInSlot(createLeaf('github'), 'center', slotOf)
    const evicted = createLeaf('nvim')
    expect(leaves(evicted).some((leaf) => centre.includes(leaf.paneTypeId))).toBe(false)
    const split = createSplit('row', [createLeaf('github'), createLeaf('nvim')])
    expect(leaves(split).some((leaf) => centre.includes(leaf.paneTypeId))).toBe(true)
  })
})

describe('removeLeafInto', () => {
  it('gives the vacated space back to the named pane, not to everything', () => {
    const tree = createSplit('row', [createLeaf('files'), createLeaf('nvim'), createLeaf('github')])
    const editor = leaves(tree)[1]
    const withDiff = splitLeaf(tree, editor.id, 'row', createLeaf('nvim-grid'), 'before')
    const diff = leaves(withDiff).find((leaf) => leaf.paneTypeId === 'nvim-grid')!

    const after = removeLeafInto(withDiff, diff.id, editor.id) as SplitNode
    const index = after.children.findIndex((child) => findLeaf(child, editor.id) !== null)
    expect(after.sizes[index]).toBeCloseTo(1 / 3, 5)
    expect(sum(after.sizes)).toBeCloseTo(1, 5)
  })

  it('survives repeated split/remove without shrinking the pane that lends', () => {
    let tree: LayoutNode = createSplit('row', [
      createLeaf('files'),
      createLeaf('nvim'),
      createLeaf('github')
    ])
    const editor = leaves(tree)[1]

    // What opening ten diffs in a row does: each one splits the editor and each
    // close hands the space back.
    for (let round = 0; round < 10; round += 1) {
      tree = splitLeaf(tree, editor.id, 'row', createLeaf('nvim-grid'), 'before')
      const diff = leaves(tree).find((leaf) => leaf.paneTypeId === 'nvim-grid')!
      tree = removeLeafInto(tree, diff.id, editor.id) as LayoutNode
    }

    const split = tree as SplitNode
    const index = split.children.findIndex((child) => findLeaf(child, editor.id) !== null)
    expect(split.sizes[index]).toBeCloseTo(1 / 3, 5)
  })
})

// Every view keeps its own tree and only the active one is on screen, but a
// hidden view's editor is still running and still reporting its windows.
describe('syncNvimWindowLeaves', () => {
  function window(
    win: number,
    position: { row: number; col: number },
    overrides: { kind?: string; hidden?: boolean } = {}
  ): { grid: number; win: number; kind: string; row: number; col: number; hidden: boolean } {
    return {
      grid: win,
      win,
      kind: overrides.kind ?? 'normal',
      row: position.row,
      col: position.col,
      hidden: overrides.hidden ?? false
    }
  }

  function mirrors(tree: LayoutNode): LeafNode[] {
    return leaves(tree).filter((leaf) => leaf.paneTypeId === 'nvim-grid')
  }

  it('gives every window past the first a leaf beside the editor', () => {
    const editor = createLeaf('nvim')
    const tree = syncNvimWindowLeaves(
      editor,
      editor.id,
      'nvim-1',
      [window(1000, { row: 0, col: 0 }), window(1001, { row: 0, col: 100 })]
    )

    expect(mirrors(tree).map((leaf) => leaf.paneState?.win)).toEqual([1001])
    expect(mirrors(tree)[0].paneState).toMatchObject({
      transient: true,
      ownerLeafId: editor.id,
      nvimId: 'nvim-1'
    })
  })

  it('splits sideways or downwards to match where the window sits', () => {
    const editor = createLeaf('nvim')
    const beside = syncNvimWindowLeaves(editor, editor.id, 'nvim-1', [
      window(1000, { row: 0, col: 0 }),
      window(1001, { row: 0, col: 100 })
    ])
    const below = syncNvimWindowLeaves(editor, editor.id, 'nvim-1', [
      window(1000, { row: 0, col: 0 }),
      window(1001, { row: 40, col: 0 })
    ])

    expect((beside as SplitNode).direction).toBe('row')
    expect((below as SplitNode).direction).toBe('column')
  })

  it('takes a leaf away once its window has closed', () => {
    const editor = createLeaf('nvim')
    const split = syncNvimWindowLeaves(editor, editor.id, 'nvim-1', [
      window(1000, { row: 0, col: 0 }),
      window(1001, { row: 0, col: 100 })
    ])
    const closed = syncNvimWindowLeaves(split, editor.id, 'nvim-1', [
      window(1000, { row: 0, col: 0 })
    ])

    expect(mirrors(closed)).toEqual([])
    expect(leaves(closed).map((leaf) => leaf.id)).toEqual([editor.id])
  })

  it('keeps a leaf whose window is merely redrawn', () => {
    const editor = createLeaf('nvim')
    const windows = [window(1000, { row: 0, col: 0 }), window(1001, { row: 0, col: 100 })]
    const split = syncNvimWindowLeaves(editor, editor.id, 'nvim-1', windows)
    const again = syncNvimWindowLeaves(split, editor.id, 'nvim-1', windows)

    expect(again).toBe(split)
  })

  // The bug: the hidden Code view's editor mirrored its windows into whichever
  // tree was on screen, so panes it owned appeared in the GitHub view — and the
  // ones it really owned were never cleaned up when their windows closed.
  it('leaves a tree that does not hold the editor alone', () => {
    const elsewhere = createSplit('row', [createLeaf('github'), createLeaf('agent')])
    const next = syncNvimWindowLeaves(elsewhere, 'leaf-not-here', 'nvim-1', [
      window(1000, { row: 0, col: 0 }),
      window(1001, { row: 0, col: 100 })
    ])

    expect(next).toBe(elsewhere)
  })

  it('ignores floats and windows neovim has hidden', () => {
    const editor = createLeaf('nvim')
    const tree = syncNvimWindowLeaves(editor, editor.id, 'nvim-1', [
      window(1000, { row: 0, col: 0 }),
      window(1001, { row: 0, col: 100 }, { kind: 'float' }),
      window(1002, { row: 0, col: 100 }, { hidden: true })
    ])

    expect(tree).toBe(editor)
  })
})
