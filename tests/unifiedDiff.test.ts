import { describe, expect, test } from 'bun:test'
import { buildUnified } from '../src/renderer/src/lib/unifiedDiff'

// original: a b c d e f   modified: a B c <ins1> <ins2> d e
const original = ['a', 'b', 'c', 'd', 'e', 'f']
const modified = ['a', 'B', 'c', 'ins1', 'ins2', 'd', 'e']

// Modify line 2, insert two lines after original line 3, delete line 6.
const hunks = [
  { originalStart: 2, originalCount: 1, modifiedStart: 2, modifiedCount: 1 },
  { originalStart: 3, originalCount: 0, modifiedStart: 4, modifiedCount: 2 },
  { originalStart: 6, originalCount: 1, modifiedStart: 7, modifiedCount: 0 }
]

describe('buildUnified', () => {
  test('interleaves removed and added lines with context', () => {
    const { lines } = buildUnified(original, modified, hunks)
    // a | b(-) B(+) | c | ins1(+) ins2(+) | d e | f(-)
    expect(lines).toEqual(['a', 'b', 'B', 'c', 'ins1', 'ins2', 'd', 'e', 'f'])
  })

  test('tags the removed and added output line numbers', () => {
    const { removed, added } = buildUnified(original, modified, hunks)
    expect(removed).toEqual([2, 9]) // 'b' at line 2, 'f' at line 9
    expect(added).toEqual([3, 5, 6]) // 'B' at 3, 'ins1' at 5, 'ins2' at 6
  })

  test('no hunks yields the original unchanged', () => {
    const { lines, removed, added } = buildUnified(original, modified, [])
    expect(lines).toEqual(original)
    expect(removed).toEqual([])
    expect(added).toEqual([])
  })
})
