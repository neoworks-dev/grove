// Wheel travel for the editor, in lines. Neovim scrolls by whole lines per
// wheel event ('mousescroll', set to one line in the bundled config), so
// forwarding every event made a touchpad, which sends many small ones, jump
// three lines per twitch, and made a mouse notch a fixed step whatever its
// size. The distance is accumulated in pixels instead and handed over a line
// at a time, carrying the remainder into the next event.

// DOM WheelEvent.deltaMode values.
const DELTA_LINE = 1
const DELTA_PAGE = 2

// No single event scrolls further than this, so a runaway delta can't queue a
// flood of input.
const MAX_LINES_PER_EVENT = 60

export class WheelAccumulator {
  private pending = 0

  /**
   * Whole lines to scroll for one wheel delta, positive towards the end of the
   * buffer. Travel short of a line is kept for the next call; a reversal drops
   * what was left over in the old direction.
   */
  lines(delta: number, deltaMode: number, lineHeight: number, pageHeight: number): number {
    const pixels = toPixels(delta, deltaMode, lineHeight, pageHeight)
    if (pixels === 0 || lineHeight <= 0) return 0
    if (Math.sign(pixels) !== Math.sign(this.pending)) this.pending = 0
    this.pending += pixels
    const whole = Math.trunc(this.pending / lineHeight)
    if (whole === 0) return 0
    this.pending -= whole * lineHeight
    return Math.max(-MAX_LINES_PER_EVENT, Math.min(MAX_LINES_PER_EVENT, whole))
  }
}

/** A wheel delta in pixels, whatever unit the event reported it in. */
function toPixels(
  delta: number,
  deltaMode: number,
  lineHeight: number,
  pageHeight: number
): number {
  if (deltaMode === DELTA_LINE) return delta * lineHeight
  if (deltaMode === DELTA_PAGE) return delta * pageHeight
  return delta
}
