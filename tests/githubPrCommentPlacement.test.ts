import { describe, it, expect } from 'bun:test'
import {
  BOX_MARGIN,
  BOX_WIDTH,
  placeCommentBox,
  type CommentAnchor
} from '../src/renderer/src/kernel/plugins/github/prCommentPlacement'

// A cursor a third of the way down a roomy pane, which is the ordinary case.
function anchor(overrides: Partial<CommentAnchor> = {}): CommentAnchor {
  return {
    rowTop: 200,
    columnLeft: 300,
    rowHeight: 20,
    boxHeight: 140,
    paneWidth: 1000,
    paneHeight: 800,
    ...overrides
  }
}

describe('placeCommentBox', () => {
  it('opens under the line, so the line it is about stays in view', () => {
    const placed = placeCommentBox(anchor())
    expect(placed.below).toBe(true)
    expect(placed.top).toBe(220)
  })

  it('flips over the line when there is no room underneath', () => {
    // 700 + 20 + 140 runs past the bottom of an 800px pane.
    const placed = placeCommentBox(anchor({ rowTop: 700 }))
    expect(placed.below).toBe(false)
    // Anchored on the line itself; the box is drawn upwards from there.
    expect(placed.top).toBe(700)
  })

  it('takes the room it has exactly, and no more', () => {
    const exact = placeCommentBox(anchor({ rowTop: 640 }))
    expect(exact.below).toBe(true)
    expect(placeCommentBox(anchor({ rowTop: 641 })).below).toBe(false)
  })

  it('starts at the cursor column', () => {
    expect(placeCommentBox(anchor()).left).toBe(300)
  })

  it('moves back inside the pane rather than running off a long line', () => {
    const placed = placeCommentBox(anchor({ columnLeft: 900 }))
    expect(placed.left).toBe(1000 - BOX_WIDTH - BOX_MARGIN)
    expect(placed.left + placed.width + BOX_MARGIN).toBe(1000)
  })

  it('narrows to fit a pane too small to hold it', () => {
    const placed = placeCommentBox(anchor({ paneWidth: 300, columnLeft: 120 }))
    expect(placed.width).toBe(300 - BOX_MARGIN * 2)
    expect(placed.left).toBe(BOX_MARGIN)
  })

  // The first frame runs before the pane has been measured; it should look like
  // the ordinary case rather than collapsing to nothing.
  it('goes below at full width before the pane has been measured', () => {
    const placed = placeCommentBox(anchor({ paneWidth: 0, paneHeight: 0, rowTop: 700 }))
    expect(placed).toMatchObject({ below: true, width: BOX_WIDTH, top: 720, left: 300 })
  })
})
