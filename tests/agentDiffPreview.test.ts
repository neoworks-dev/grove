import { describe, expect, test } from 'bun:test'
import { fileDiffsOf, hunksOf, statsOf } from '../src/renderer/src/lib/agents/diff'

/** The lines of a file numbered `line 1` … `line n`. */
function numberedFile(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`)
}

describe('fileDiffsOf', () => {
  test('keeps diff entries and drops text and terminals', () => {
    const diffs = fileDiffsOf([
      { type: 'content' },
      { type: 'diff', path: '/repo/a.ts', oldText: 'a\n', newText: 'b\n' } as { type: string },
      { type: 'terminal' },
      { type: 'diff', path: '/repo/new.ts', newText: 'x\n' } as { type: string }
    ])
    expect(diffs).toEqual([
      { path: '/repo/a.ts', oldText: 'a\n', newText: 'b\n' },
      { path: '/repo/new.ts', oldText: null, newText: 'x\n' }
    ])
  })
})

describe('hunksOf', () => {
  test('a fragment edit shows only what changed, without a trailing blank line', () => {
    const hunks = hunksOf('# Demo\n', '# Demo Demo\n', 2)
    expect(hunks).toEqual([
      [
        { kind: 'removed', text: '# Demo' },
        { kind: 'added', text: '# Demo Demo' }
      ]
    ])
  })

  test('a one-line change in a whole file keeps just its context', () => {
    const before = numberedFile(100)
    const after = [...before]
    after[49] = 'changed'
    const hunks = hunksOf(before.join('\n') + '\n', after.join('\n') + '\n', 2)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.map((line) => line.text)).toEqual([
      'line 48',
      'line 49',
      'line 50',
      'changed',
      'line 51',
      'line 52'
    ])
  })

  test('changes far apart become separate hunks; close ones merge', () => {
    const before = numberedFile(40)
    const apart = [...before]
    apart[4] = 'first'
    apart[30] = 'second'
    expect(hunksOf(before.join('\n'), apart.join('\n'), 2)).toHaveLength(2)

    const close = [...before]
    close[4] = 'first'
    close[8] = 'second'
    expect(hunksOf(before.join('\n'), close.join('\n'), 2)).toHaveLength(1)
  })

  test('a new file is all added lines', () => {
    const hunks = hunksOf(null, 'one\ntwo\n', 2)
    expect(hunks).toHaveLength(1)
    expect(statsOf(hunks[0]!)).toEqual({ added: 2, removed: 0 })
  })

  test('an unchanged file has no hunks', () => {
    expect(hunksOf('same\n', 'same\n', 2)).toEqual([])
  })
})
