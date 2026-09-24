import { describe, it, expect } from 'bun:test'
import { fitScale, zoomAbout } from '../src/renderer/src/lib/mediaView'

describe('fitScale', () => {
  it('shrinks a large image to fit inside the margin', () => {
    expect(fitScale(2000, 1000, 1048, 1048)).toBeCloseTo(0.5)
  })

  it('never enlarges a small image', () => {
    expect(fitScale(16, 16, 800, 600)).toBe(1)
  })
})

describe('zoomAbout', () => {
  it('keeps the point under the cursor fixed', () => {
    const zoomed = zoomAbout({ scale: 1, x: 10, y: 20 }, 2, 110, 120, 0.1, 10)
    // Content point (100, 100) was under (110, 120) and still is.
    expect(zoomed.x + 100 * zoomed.scale).toBeCloseTo(110)
    expect(zoomed.y + 100 * zoomed.scale).toBeCloseTo(120)
  })

  it('holds the scale within its bounds', () => {
    expect(zoomAbout({ scale: 8, x: 0, y: 0 }, 4, 0, 0, 0.1, 10).scale).toBe(10)
  })
})
