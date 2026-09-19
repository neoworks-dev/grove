import { describe, expect, test } from 'bun:test'
import { buildEdges, CanvasGridRenderer } from '../src/renderer/src/lib/nvim/canvasRenderer'

/**
 * Enough of a canvas for `resize`: it writes width/height and a CSS size, and
 * asks for a 2D context it only draws on when carrying a frame over.
 */
function fakeCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: () => null
  } as unknown as HTMLCanvasElement
}

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

// The caller that paints a grid has to be able to tell whether the edges still
// describe it. Painting a 43-column grid against edges built for 87 columns
// draws every glyph at half an advance, on top of the one before it — which is
// what a pane looked like once a diff split its window in two.
describe('CanvasGridRenderer grid geometry', () => {
  test('reports the grid its edges were built for', () => {
    const renderer = new CanvasGridRenderer()
    renderer.attach(fakeCanvas())
    renderer.resize(87, 40, 1, 338, 787)
    expect(renderer.gridCols).toBe(87)
    expect(renderer.gridRows).toBe(40)
  })

  test('follows the grid when it shrinks inside an unchanged box', () => {
    const renderer = new CanvasGridRenderer()
    renderer.attach(fakeCanvas())
    renderer.resize(87, 40, 1, 338, 787)
    renderer.resize(43, 39, 1, 338, 787)
    expect(renderer.gridCols).toBe(43)
    expect(renderer.gridRows).toBe(39)
  })

  test('reports nothing before a resize', () => {
    const renderer = new CanvasGridRenderer()
    renderer.attach(fakeCanvas())
    expect(renderer.gridCols).toBe(0)
    expect(renderer.gridRows).toBe(0)
  })
})
