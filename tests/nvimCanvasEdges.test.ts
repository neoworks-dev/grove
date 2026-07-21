import { describe, expect, test } from 'bun:test'
import { buildEdges } from '../src/renderer/src/lib/nvim/canvasRenderer'

function widths(edges: number[]): number[] {
  const result: number[] = []
  for (let index = 1; index < edges.length; index += 1) {
    result.push(edges[index] - edges[index - 1])
  }
  return result
}

describe('buildEdges', () => {
  test('spans exactly 0..total with count+1 edges', () => {
    const edges = buildEdges(37, 813)
    expect(edges.length).toBe(38)
    expect(edges[0]).toBe(0)
    expect(edges[37]).toBe(813)
  })

  test('all edges are integers', () => {
    const edges = buildEdges(41, 999)
    for (const edge of edges) {
      expect(Number.isInteger(edge)).toBe(true)
    }
  })

  test('consecutive widths differ by at most one px', () => {
    const edges = buildEdges(40, 727)
    const cellWidths = widths(edges)
    const min = Math.min(...cellWidths)
    const max = Math.max(...cellWidths)
    expect(max - min).toBeLessThanOrEqual(1)
  })

  test('widths sum to total (no gap, no overrun)', () => {
    const edges = buildEdges(19, 500)
    const sum = widths(edges).reduce((acc, value) => acc + value, 0)
    expect(sum).toBe(500)
  })

  test('exact multiple yields uniform cells', () => {
    const edges = buildEdges(10, 80)
    expect(widths(edges)).toEqual(new Array(10).fill(8))
  })
})
