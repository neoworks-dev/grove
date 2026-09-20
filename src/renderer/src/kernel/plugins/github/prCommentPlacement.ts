// Where the review comment box goes, given where Neovim says the cursor is.
//
// The anchor is a screen row and column, not a buffer line: a diff is mostly
// filler lines, and folds and wrapping move a line as well, so counting buffer
// lines down from the top of the window lands rows away from the cursor — on
// the base side of a diff, by as many rows as the pull request deleted above it.

/** How wide the box wants to be, and how close it may come to a pane edge. */
export const BOX_WIDTH = 420
export const BOX_MARGIN = 8

export interface CommentAnchor {
  /** Pixel top of the cursor's row within the pane. */
  rowTop: number
  /** Pixel left of the cursor's column within the pane. */
  columnLeft: number
  rowHeight: number
  boxHeight: number
  paneWidth: number
  paneHeight: number
}

export interface CommentPlacement {
  top: number
  left: number
  width: number
  /** False when the box was flipped over the line for want of room below it. */
  below: boolean
}

/**
 * Place the box under the line it is about, so that line stays in view above
 * it, flipping over the line only when there is no room left underneath.
 *
 * A pane that has not been measured yet reports zero; the box goes below and
 * takes its full width, which is what the first frame should look like.
 */
export function placeCommentBox(anchor: CommentAnchor): CommentPlacement {
  const width = fittedWidth(anchor.paneWidth)
  const below =
    anchor.paneHeight === 0 ||
    anchor.rowTop + anchor.rowHeight + anchor.boxHeight <= anchor.paneHeight
  return {
    top: below ? anchor.rowTop + anchor.rowHeight : anchor.rowTop,
    left: clampedLeft(anchor.columnLeft, width, anchor.paneWidth),
    width,
    below
  }
}

/** As wide as it wants, or as wide as the pane leaves it. */
function fittedWidth(paneWidth: number): number {
  if (paneWidth === 0) return BOX_WIDTH
  return Math.min(BOX_WIDTH, Math.max(0, paneWidth - BOX_MARGIN * 2))
}

/**
 * The cursor's column, moved back inside the pane. A box that starts at the
 * column of a long line runs off the edge, and the end of it is where the
 * buttons are.
 */
function clampedLeft(columnLeft: number, width: number, paneWidth: number): number {
  if (paneWidth === 0) return columnLeft
  const rightmost = paneWidth - width - BOX_MARGIN
  return Math.max(BOX_MARGIN, Math.min(columnLeft, rightmost))
}
