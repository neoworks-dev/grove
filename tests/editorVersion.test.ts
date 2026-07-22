import { describe, it, expect } from 'bun:test'
import {
  prepareEdits,
  applyPreparedToLines,
  type RangedEdit
} from '../src/main/editorDocs'

function edit(
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  newText: string
): RangedEdit {
  return {
    range: {
      start: { line: startLine, column: startCol },
      end: { line: endLine, column: endCol }
    },
    newText
  }
}

describe('prepareEdits', () => {
  it('converts to 0-based and sorts descending by start', () => {
    const prepared = prepareEdits([edit(1, 1, 1, 3, 'a'), edit(5, 2, 5, 4, 'b')])
    expect(prepared[0].startRow).toBe(4)
    expect(prepared[1].startRow).toBe(0)
    expect(prepared[1].startCol).toBe(0)
    expect(prepared[1].endCol).toBe(2)
  })

  it('rejects overlapping edits', () => {
    expect(() => prepareEdits([edit(1, 1, 2, 5, 'a'), edit(2, 3, 3, 1, 'b')])).toThrow(
      'overlapping'
    )
  })

  it('allows touching (non-overlapping) edits', () => {
    const prepared = prepareEdits([edit(1, 1, 1, 3, 'a'), edit(1, 3, 1, 5, 'b')])
    expect(prepared).toHaveLength(2)
  })

  it('rejects inverted ranges and 0-based positions', () => {
    expect(() => prepareEdits([edit(2, 1, 1, 1, 'x')])).toThrow('precedes')
    expect(() => prepareEdits([edit(0, 1, 1, 1, 'x')])).toThrow('1-based')
  })
})

describe('applyPreparedToLines', () => {
  const lines = ['const a = 1', 'const b = 2', 'const c = 3']

  it('replaces a single-line range', () => {
    const prepared = prepareEdits([edit(2, 7, 2, 8, 'x')])
    expect(applyPreparedToLines(lines, prepared)).toEqual([
      'const a = 1',
      'const x = 2',
      'const c = 3'
    ])
  })

  it('applies multiple edits without invalidating positions', () => {
    const prepared = prepareEdits([edit(1, 7, 1, 8, 'first'), edit(3, 7, 3, 8, 'third')])
    expect(applyPreparedToLines(lines, prepared)).toEqual([
      'const first = 1',
      'const b = 2',
      'const third = 3'
    ])
  })

  it('handles multi-line replacements and insertions', () => {
    const replace = prepareEdits([edit(1, 11, 2, 12, 'ONE\nconst mid = 9\nconst b = TWO')])
    expect(applyPreparedToLines(lines, replace)).toEqual([
      'const a = ONE',
      'const mid = 9',
      'const b = TWO',
      'const c = 3'
    ])
    const insert = prepareEdits([edit(2, 1, 2, 1, '// note\n')])
    expect(applyPreparedToLines(lines, insert)).toEqual([
      'const a = 1',
      '// note',
      'const b = 2',
      'const c = 3'
    ])
  })
})
