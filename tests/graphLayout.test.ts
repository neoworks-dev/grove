// The commit graph's lane layout: which column each commit lands in, and the
// lines a row draws above and below it. Histories are written out by hand,
// children first, the way `git log --date-order` returns them.

import { describe, expect, test } from 'bun:test'
import { layoutGraph, type GraphCommit } from '../src/renderer/src/kernel/plugins/gitGraph/graphLayout'

/** A commit with the given parents. */
function commit(sha: string, ...parents: string[]): GraphCommit {
  return { sha, parents }
}

describe('layoutGraph', () => {
  test('a straight history stays in one column', () => {
    const layout = layoutGraph([commit('c', 'b'), commit('b', 'a'), commit('a')])
    expect(layout.columns).toBe(1)
    expect(layout.rows.map((row) => row.column)).toEqual([0, 0, 0])
    expect(layout.rows[0].above).toEqual([])
    expect(layout.rows[1].above).toEqual([{ from: 0, to: 0, colour: 0 }])
    expect(layout.rows[2].below).toEqual([])
  })

  test('a merge opens a column for its second parent, which joins back at the fork', () => {
    // m merges s into b; s and b both come from a.
    const layout = layoutGraph([
      commit('m', 'b', 's'),
      commit('s', 'a'),
      commit('b', 'a'),
      commit('a')
    ])
    expect(layout.columns).toBe(2)
    expect(layout.rows.map((row) => row.column)).toEqual([0, 1, 0, 0])
    expect(layout.rows[0].below).toEqual([
      { from: 0, to: 0, colour: 0 },
      { from: 0, to: 1, colour: 1 }
    ])
    // s's line heads for a, which column 0 will also reach after b: it stays
    // in column 1 until a, where both lines come in.
    expect(layout.rows[3].above).toEqual([
      { from: 0, to: 0, colour: 0 },
      { from: 1, to: 0, colour: 1 }
    ])
    expect(layout.rows[3].below).toEqual([])
  })

  test('two branch tips get their own columns and colours', () => {
    const layout = layoutGraph([commit('x', 'a'), commit('y', 'a'), commit('a')])
    expect(layout.rows.map((row) => row.column)).toEqual([0, 1, 0])
    expect(layout.rows[0].colour).not.toBe(layout.rows[1].colour)
    // y's parent is already awaited in column 0, so y's line bends over to it.
    expect(layout.rows[1].below).toEqual([
      { from: 1, to: 0, colour: 0 },
      { from: 0, to: 0, colour: 0 }
    ])
  })

  test('a column freed by an ended branch is reused', () => {
    const layout = layoutGraph([
      commit('x', 'a'),
      commit('y', 'a'),
      commit('a', 'r'),
      commit('z', 'r'),
      commit('r')
    ])
    expect(layout.rows.map((row) => row.column)).toEqual([0, 1, 0, 1, 0])
    expect(layout.columns).toBe(2)
  })

  test('a parent the page has not reached yet keeps its line running to the bottom', () => {
    const layout = layoutGraph([commit('b', 'a')])
    expect(layout.rows[0].below).toEqual([{ from: 0, to: 0, colour: 0 }])
  })
})
