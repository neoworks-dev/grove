// Whether a transcript keeps following its newest output after a scroll event.
//
// A scroll event says the offset changed, not who changed it. Following moves
// the offset itself, and scroll events are dispatched a frame later, after more
// output may already have landed — so measured then, the transcript can look
// scrolled away from the bottom when only the content grew under it. Only a move
// upwards is the user leaving; anything else keeps following.

/** Distance from the bottom, in pixels, still counted as being at it. */
export const BOTTOM_SLACK = 40

export interface ScrollPosition {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Whether to keep following, given the offset at the previous scroll event and the position now. */
export function followsAfterScroll(
  following: boolean,
  previousScrollTop: number,
  position: ScrollPosition
): boolean {
  const distance = position.scrollHeight - position.scrollTop - position.clientHeight
  if (distance < BOTTOM_SLACK) return true
  if (position.scrollTop < previousScrollTop) return false
  return following
}
