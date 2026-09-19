import { describe, expect, test } from 'bun:test'
import { renderPaneTypes, renderSnapshot } from '../scripts/qa/tree.ts'
import type { Snapshot } from '../scripts/qa/snapshot.ts'

/** A session with the sidebar, the editor and the agent panel open. */
function session(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    window: { width: 1512, height: 982 },
    view: { id: 'code', label: 'Code' },
    worktree: '/home/someone/Documents/grove-demo',
    activeTab: '/home/someone/Documents/grove-demo/README.md',
    activePane: 'nvim',
    activeLeafId: 'leaf-2',
    leafBoxes: {},
    gutters: ['split-1:0', 'split-1:1'],
    agentSessions: [],
    reviewQueue: 0,
    errors: { count: 0, recent: [] },
    gutterElements: {
      'split-1:0': [
        { ref: 'e8', role: 'button', name: 'Open a pane here', at: '250,500', size: '20x20' }
      ]
    },
    overlays: [],
    tree: {
      kind: 'split',
      id: 'split-1',
      direction: 'row',
      sizes: [0.2, 0.6, 0.2],
      children: [
        {
          kind: 'leaf',
          id: 'leaf-1',
          paneTypeId: 'explorer',
          title: 'Explorer',
          focused: false,
          slot: 'sidebar',
          sizePx: 248,
          width: 248,
          height: 946,
          elements: [
            { ref: 'e1', role: 'treeitem', name: 'README.md', at: '120,310', size: '245x18' }
          ]
        },
        {
          kind: 'leaf',
          id: 'leaf-2',
          paneTypeId: 'nvim',
          title: 'Editor',
          focused: true,
          slot: 'center',
          width: 912,
          height: 946,
          elements: [{ ref: 'e2', role: 'canvas', name: '', at: '700,500', size: '912x920' }]
        },
        {
          kind: 'leaf',
          id: 'leaf-3',
          paneTypeId: 'agent',
          title: 'Agent',
          focused: false,
          width: 352,
          height: 946,
          elements: [
            { ref: 'e3', role: 'textbox', name: 'Ask anything', at: '1300,900', size: '340x60' },
            {
              ref: 'e4',
              role: 'button',
              name: 'Send',
              at: '1480,900',
              size: '24x24',
              disabled: true
            }
          ]
        }
      ]
    },
    ...overrides
  }
}

describe('renderSnapshot', () => {
  test('draws the panes as the tree they are', () => {
    const lines = renderSnapshot(session()).split('\n')

    expect(lines[0]).toContain('1512x982')
    expect(lines[0]).toContain('view=code')
    expect(lines[1]).toContain('focus=leaf-2 (nvim)')
    expect(lines[1]).toContain('tab=README.md')
    expect(lines[1]).toContain('errors=0')

    const tree = lines.join('\n')
    expect(tree).toContain('split-1  row  20% 60% 20%')
    // The title is only printed when it says something the type id does not.
    expect(tree).toContain('├─ leaf-1  explorer  248x946  fixed=248px')
    expect(tree).toContain('└─ leaf-3  agent')
    // The focused pane is marked, and nothing else is.
    expect(tree.match(/★focus/g)).toHaveLength(1)
    expect(tree).toContain('leaf-2  nvim  "Editor"  912x946  ★focus')
  })

  test('elements hang off the pane that holds them', () => {
    const tree = renderSnapshot(session())
    expect(tree).toContain('treeitem "README.md" e1')
    expect(tree).toContain('canvas e2')
    expect(tree).toContain('textbox "Ask anything" e3 · button "Send" e4 (disabled)')
  })

  test('a gutter is a line of its own, so it can be named in a drag', () => {
    const tree = renderSnapshot(session())
    expect(tree).toContain('split-1:0  ↔ gutter')
    expect(tree).toContain('split-1:1  ↔ gutter')
    // The `+` that opens a pane in the gap belongs to the gutter, not to a pane.
    expect(tree).toContain('↔ gutter  button "Open a pane here" e8')
  })

  test('a gutter the tree has but the DOM does not is not offered', () => {
    const tree = renderSnapshot(session({ gutters: [], focusMode: true }))
    expect(tree).not.toContain('gutter')
    expect(tree).toContain('focus-mode')
  })

  test('a pane with nothing in it says so rather than looking truncated', () => {
    const only = session()
    const tree = renderSnapshot(
      session({
        tree: {
          ...(only.tree as Extract<Snapshot['tree'], { kind: 'split' }>),
          children: [
            {
              kind: 'leaf',
              id: 'leaf-9',
              paneTypeId: 'github',
              title: 'GitHub',
              focused: false,
              width: 400,
              height: 900,
              elements: []
            }
          ],
          sizes: [1]
        }
      })
    )
    expect(tree).toContain('(nothing to act on)')
  })

  test('overlays are listed apart from the tree they are drawn over', () => {
    const tree = renderSnapshot(
      session({
        overlays: [{ ref: 'e9', role: 'menuitem', name: 'Close pane', at: '10,10', size: '80x20' }]
      })
    )
    expect(tree).toContain('overlays')
    expect(tree).toContain('menuitem "Close pane" e9')
  })

  test('a filter narrows the elements and says that it did', () => {
    const tree = renderSnapshot(session({ filter: 'Send' }))
    expect(tree).toContain('filter="Send"')
  })

  test('errors are reported under the tree, not hidden in a count', () => {
    const tree = renderSnapshot(
      session({
        errors: { count: 3, recent: ['TypeError: x is not a function\n  at boot'] },
        storeError: 'could not open the repository',
        bootError: 'Error: plugin failed\n  at load'
      })
    )
    expect(tree).toContain('errors=3')
    expect(tree).toContain('store error: could not open the repository')
    expect(tree).toContain('boot error')
    // One line each: a stack in the middle of a tree buries everything after it.
    expect(tree).toContain('  Error: plugin failed')
    expect(tree).not.toContain('at load')
    expect(tree).toContain('TypeError: x is not a function')
  })

  test('a remembered focus this view does not have is reported as no focus', () => {
    const header = renderSnapshot(session({ activeLeafId: 'leaf-99' })).split('\n')[1]
    expect(header).toContain('focus=none (leaf-99 is not in this view)')
  })

  test('a session with no tree says so instead of drawing nothing', () => {
    expect(renderSnapshot(session({ tree: null }))).toContain('no layout tree')
  })
})

describe('renderPaneTypes', () => {
  test('one line per type, with what it takes to open it', () => {
    const listing = renderPaneTypes([
      {
        id: 'explorer',
        title: 'Explorer',
        slot: 'sidebar',
        edge: 'left',
        rail: true,
        open: ['leaf-1']
      },
      { id: 'github', title: 'GitHub', unavailable: true }
    ])
    expect(listing).toContain('2 pane types')
    expect(listing).toContain('explorer  Explorer  slot=sidebar  edge=left  rail  open: leaf-1')
    expect(listing).toContain('github    GitHub    unavailable here')
  })
})
