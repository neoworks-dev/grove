import { describe, expect, test } from 'bun:test'
import { Box3, PerspectiveCamera, Vector3 } from 'three'
import { frameCamera } from '../src/renderer/src/lib/modelStage'

/** Every corner of `box`, projected into the camera's normalised device coordinates. */
function projectedCorners(camera: PerspectiveCamera, box: Box3): Vector3[] {
  const corners: Vector3[] = []
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        corners.push(new Vector3(x, y, z).project(camera))
      }
    }
  }
  return corners
}

/** Frames `box` in a camera of the given aspect and reports whether all of it is on screen. */
function fitsOnScreen(box: Box3, aspect: number): boolean {
  const camera = new PerspectiveCamera(45, aspect, 0.01, 1000)
  frameCamera(camera, box)
  camera.updateMatrixWorld()
  return projectedCorners(camera, box).every(
    (corner) => Math.abs(corner.x) <= 1 && Math.abs(corner.y) <= 1
  )
}

describe('framing a model', () => {
  const unitCube = new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5))

  test('a unit cube fits a square pane', () => {
    expect(fitsOnScreen(unitCube, 1)).toBe(true)
  })

  test('a unit cube fits a tall, narrow pane', () => {
    expect(fitsOnScreen(unitCube, 0.4)).toBe(true)
  })

  test('a long, flat model fits a wide pane', () => {
    const plank = new Box3(new Vector3(-4, -0.1, -0.5), new Vector3(4, 0.1, 0.5))
    expect(fitsOnScreen(plank, 2)).toBe(true)
  })
})
