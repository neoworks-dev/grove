import { describe, expect, test } from 'bun:test'
import { parseInlineHunks, rebuildWithAccepted } from '../src/main/inlineDiff'

// A representative `git diff --no-index -U0` between a snapshot and the file the
// agent rewrote (one modification, one insertion, one deletion).
const DIFF = `diff --git a/before b/after
--- a/before
+++ b/after
@@ -2,1 +2,1 @@
-const b = 1
+const b = 2
@@ -4,0 +5,2 @@
+// added line one
+// added line two
@@ -6,1 +8,0 @@
-const f = 6
`

describe('parseInlineHunks', () => {
  test('parses modify/insert/delete hunks with their line bodies', () => {
    const hunks = parseInlineHunks(DIFF)
    expect(hunks).toHaveLength(3)
    expect(hunks[0]).toEqual({ beforeStart: 2, removed: ['const b = 1'], afterStart: 2, added: ['const b = 2'] })
    expect(hunks[1]).toEqual({ beforeStart: 4, removed: [], afterStart: 5, added: ['// added line one', '// added line two'] })
    expect(hunks[2]).toEqual({ beforeStart: 6, removed: ['const f = 6'], afterStart: 8, added: [] })
  })

  test('ignores file-header +/- lines before the first hunk', () => {
    expect(parseInlineHunks('--- a/before\n+++ b/after\n')).toEqual([])
  })
})

describe('rebuildWithAccepted', () => {
  const snapshot = 'const a = 0\nconst b = 1\nconst c = 2\nconst d = 3\nconst e = 4\nconst f = 6\n'
  const hunks = parseInlineHunks(DIFF)

  test('applying every hunk reproduces the agent-written file', () => {
    const applied = hunks.map(() => true)
    const { content } = rebuildWithAccepted(snapshot, hunks, applied)
    expect(content).toBe(
      'const a = 0\nconst b = 2\nconst c = 2\nconst d = 3\n// added line one\n// added line two\nconst e = 4\n'
    )
  })

  test('rejecting every hunk restores the snapshot exactly', () => {
    const { content } = rebuildWithAccepted(snapshot, hunks, hunks.map(() => false))
    expect(content).toBe(snapshot)
  })

  test('keeping only the modification reverts the insertion and deletion', () => {
    const { content } = rebuildWithAccepted(snapshot, hunks, [true, false, false])
    expect(content).toBe('const a = 0\nconst b = 2\nconst c = 2\nconst d = 3\nconst e = 4\nconst f = 6\n')
  })

  test('reports applied hunks output ranges, shifted by earlier hunks', () => {
    const { ranges } = rebuildWithAccepted(snapshot, hunks, [true, true, false])
    // Modification lands on line 2; the two inserted lines follow at 5-6.
    expect(ranges).toEqual([
      { hunkIndex: 0, start: 2, count: 1 },
      { hunkIndex: 1, start: 5, count: 2 }
    ])
  })
})
