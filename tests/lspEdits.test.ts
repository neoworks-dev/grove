import { expect, test, describe } from 'bun:test'
import { applyEditsToText, workspaceEditToFiles } from '../src/renderer/src/lib/lspEdits'
import { fileUri, uriToPath } from '../src/renderer/src/lib/lspUri'

function range(sl: number, sc: number, el: number, ec: number) {
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } }
}

describe('applyEditsToText', () => {
  test('replaces a single range', () => {
    const text = 'const foo = 1\n'
    const edits = [{ range: range(0, 6, 0, 9), newText: 'bar' }]
    expect(applyEditsToText(text, edits)).toBe('const bar = 1\n')
  })

  test('applies multiple edits end-to-start without offset drift', () => {
    const text = 'aaa bbb ccc'
    const edits = [
      { range: range(0, 0, 0, 3), newText: 'X' },
      { range: range(0, 8, 0, 11), newText: 'ZZZZ' }
    ]
    // Order in the array is start-first; the helper must still apply correctly.
    expect(applyEditsToText(text, edits)).toBe('X bbb ZZZZ')
  })

  test('handles multi-line ranges', () => {
    const text = 'line1\nline2\nline3'
    const edits = [{ range: range(0, 2, 2, 2), newText: 'X' }]
    expect(applyEditsToText(text, edits)).toBe('liXne3')
  })

  test('insertion (empty range)', () => {
    const text = 'ab'
    const edits = [{ range: range(0, 1, 0, 1), newText: 'XYZ' }]
    expect(applyEditsToText(text, edits)).toBe('aXYZb')
  })
})

describe('workspaceEditToFiles', () => {
  test('flattens the changes map', () => {
    const edit = {
      changes: {
        [fileUri('/repo/a.ts')]: [{ range: range(0, 0, 0, 1), newText: 'x' }],
        [fileUri('/repo/b.ts')]: [{ range: range(1, 0, 1, 1), newText: 'y' }]
      }
    }
    const files = workspaceEditToFiles(edit)
    expect(files.map((f) => f.path).sort()).toEqual(['/repo/a.ts', '/repo/b.ts'])
  })

  test('flattens documentChanges', () => {
    const edit = {
      documentChanges: [
        {
          textDocument: { uri: fileUri('/repo/c.ts'), version: 1 },
          edits: [{ range: range(0, 0, 0, 0), newText: 'z' }]
        }
      ]
    }
    const files = workspaceEditToFiles(edit)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('/repo/c.ts')
    expect(files[0].edits[0].newText).toBe('z')
  })
})

describe('uri round-trip', () => {
  test('encodes and decodes paths with spaces', () => {
    const path = '/repo/my folder/file.ts'
    expect(uriToPath(fileUri(path))).toBe(path)
  })
})
