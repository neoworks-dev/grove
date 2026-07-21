import { describe, it, expect } from 'bun:test'
import { parseUnifiedDiff, diffCounts } from '../src/renderer/src/lib/intro/introDiff'

const MULTI_HUNK = `diff --git a/tmp/before b/tmp/after
index 1234567..89abcde 100644
--- a/tmp/before
+++ b/tmp/after
@@ -1,3 +1,4 @@
 # AGENTS.md
-Old rule.
+New rule.
+Another rule.
 Context line.
@@ -10,2 +11,2 @@
 More context.
-Removed line.
+Replacement line.
`

const ADDED_FILE = `diff --git a/dev/null b/tmp/after
new file mode 100644
index 0000000..89abcde
--- /dev/null
+++ b/tmp/after
@@ -0,0 +1,2 @@
+# AGENTS.md
+First rule.
`

const NO_NEWLINE = `--- a/tmp/before
+++ b/tmp/after
@@ -1 +1 @@
-old
+new
\\ No newline at end of file
`

describe('parseUnifiedDiff', () => {
  it('parses a multi-hunk diff into typed rows', () => {
    const rows = parseUnifiedDiff(MULTI_HUNK)
    expect(rows.filter((row) => row.kind === 'hunk').length).toBe(2)
    expect(rows.filter((row) => row.kind === 'add').map((row) => row.text)).toEqual([
      'New rule.',
      'Another rule.',
      'Replacement line.'
    ])
    expect(rows.filter((row) => row.kind === 'del').map((row) => row.text)).toEqual([
      'Old rule.',
      'Removed line.'
    ])
    expect(rows.filter((row) => row.kind === 'context').map((row) => row.text)).toEqual([
      '# AGENTS.md',
      'Context line.',
      'More context.'
    ])
  })

  it('returns no rows for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('\n')).toEqual([])
  })

  it('parses an added-file diff (empty baseline)', () => {
    const rows = parseUnifiedDiff(ADDED_FILE)
    expect(rows.filter((row) => row.kind === 'del')).toEqual([])
    expect(rows.filter((row) => row.kind === 'add').map((row) => row.text)).toEqual([
      '# AGENTS.md',
      'First rule.'
    ])
  })

  it('drops the no-newline marker', () => {
    const rows = parseUnifiedDiff(NO_NEWLINE)
    expect(rows.some((row) => row.text.includes('No newline'))).toBe(false)
    expect(rows.filter((row) => row.kind === 'add').length).toBe(1)
    expect(rows.filter((row) => row.kind === 'del').length).toBe(1)
  })
})

describe('diffCounts', () => {
  it('counts added and removed rows', () => {
    const counts = diffCounts(parseUnifiedDiff(MULTI_HUNK))
    expect(counts).toEqual({ added: 3, removed: 2 })
  })

  it('is zero for an empty diff', () => {
    expect(diffCounts([])).toEqual({ added: 0, removed: 0 })
  })
})
