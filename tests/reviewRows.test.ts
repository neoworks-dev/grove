import { describe, it, expect } from 'bun:test'
import { buildDiffRows, toSideBySide } from '../src/renderer/src/lib/reviewRows'
import { parseInlineHunks } from '../src/main/inlineDiff'

// Hunks as `git diff -U0` produces them, which is what the review pipeline feeds
// in. Written as real diff text so the fixtures can't drift from the parser.
function hunksOf(diff: string) {
  return parseInlineHunks(diff)
}

describe('buildDiffRows', () => {
  it('emits the whole file, not just the changed region', () => {
    const baseline = 'a\nb\nc\nd\n'
    const rows = buildDiffRows(baseline, hunksOf('@@ -2 +2 @@\n-b\n+B\n'))
    expect(rows.map((row) => row.text)).toEqual(['a', 'b', 'B', 'c', 'd'])
    expect(rows.map((row) => row.kind)).toEqual([
      'context',
      'removed',
      'added',
      'context',
      'context'
    ])
  })

  it('numbers both sides, skipping the side a changed line does not exist on', () => {
    const rows = buildDiffRows('a\nb\n', hunksOf('@@ -2 +2 @@\n-b\n+B\n'))
    const removed = rows.find((row) => row.kind === 'removed')!
    const added = rows.find((row) => row.kind === 'added')!
    expect(removed.beforeLine).toBe(2)
    expect(removed.afterLine).toBeNull()
    expect(added.afterLine).toBe(2)
    expect(added.beforeLine).toBeNull()
    // Trailing context keeps counting on both sides.
    expect(rows[0]).toMatchObject({ beforeLine: 1, afterLine: 1 })
  })

  it('treats a pure insertion as going after its anchor line', () => {
    const rows = buildDiffRows('a\nb\n', hunksOf('@@ -1,0 +2 @@\n+NEW\n'))
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual([
      'context:a',
      'added:NEW',
      'context:b'
    ])
  })

  it('handles an insertion at the very top of the file', () => {
    const rows = buildDiffRows('a\n', hunksOf('@@ -0,0 +1 @@\n+NEW\n'))
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual(['added:NEW', 'context:a'])
  })

  it('handles a pure deletion', () => {
    const rows = buildDiffRows('a\nb\nc\n', hunksOf('@@ -2 +1,0 @@\n-b\n'))
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual([
      'context:a',
      'removed:b',
      'context:c'
    ])
  })

  it('marks only the first row of a hunk as its anchor', () => {
    const rows = buildDiffRows('a\nb\nc\n',
      hunksOf('@@ -2 +2,2 @@\n-b\n+X\n+Y\n')
    )
    const changed = rows.filter((row) => row.hunkIndex !== null)
    expect(changed.map((row) => row.hunkStart)).toEqual([true, false, false])
  })

  it('keeps hunks separated by their own index', () => {
    const rows = buildDiffRows('a\nb\nc\nd\n',
      hunksOf('@@ -1 +1 @@\n-a\n+A\n@@ -3 +3 @@\n-c\n+C\n')
    )
    const indexes = rows.filter((row) => row.hunkIndex !== null).map((row) => row.hunkIndex)
    expect(indexes).toEqual([0, 0, 1, 1])
  })

  it('orders hunks by baseline position regardless of parse order', () => {
    const rows = buildDiffRows('a\nb\nc\n',
      // Later hunk listed first — the builder must still walk the file in order.
      [
        { beforeStart: 3, removed: ['c'], afterStart: 3, added: ['C'] },
        { beforeStart: 2, removed: ['b'], afterStart: 2, added: ['B'] }
      ]
    )
    expect(rows.map((row) => row.text)).toEqual(['a', 'b', 'B', 'c', 'C'])
  })

  it('renders a new file as all additions', () => {
    const rows = buildDiffRows('', hunksOf('@@ -0,0 +1,2 @@\n+x\n+y\n'))
    expect(rows.every((row) => row.kind === 'added')).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('renders a deleted file as all removals', () => {
    const rows = buildDiffRows('x\ny\n', hunksOf('@@ -1,2 +0,0 @@\n-x\n-y\n'))
    expect(rows.every((row) => row.kind === 'removed')).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('does not invent a trailing blank line from the final newline', () => {
    const rows = buildDiffRows('a\n', [])
    expect(rows).toHaveLength(1)
  })
})

describe('toSideBySide', () => {
  it('faces a replaced line with its replacement', () => {
    const rows = buildDiffRows('a\nb\n', hunksOf('@@ -2 +2 @@\n-b\n+B\n'))
    const pairs = toSideBySide(rows)
    expect(pairs).toHaveLength(2)
    expect(pairs[0].left?.text).toBe('a')
    expect(pairs[0].right?.text).toBe('a')
    expect(pairs[1].left?.text).toBe('b')
    expect(pairs[1].right?.text).toBe('B')
  })

  it('pads the short side of an uneven block with filler', () => {
    const rows = buildDiffRows('a\nb\n',
      hunksOf('@@ -2 +2,2 @@\n-b\n+X\n+Y\n')
    )
    const pairs = toSideBySide(rows)
    expect(pairs[1].left?.text).toBe('b')
    expect(pairs[1].right?.text).toBe('X')
    // Second added line has nothing opposite it.
    expect(pairs[2].left).toBeNull()
    expect(pairs[2].right?.text).toBe('Y')
  })

  it('leaves an insertion with no left-hand line', () => {
    const rows = buildDiffRows('a\n', hunksOf('@@ -1,0 +2 @@\n+NEW\n'))
    const pairs = toSideBySide(rows)
    expect(pairs[1].left).toBeNull()
    expect(pairs[1].right?.text).toBe('NEW')
  })
})
