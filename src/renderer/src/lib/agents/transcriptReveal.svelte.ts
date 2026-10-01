// A turn to bring into view in the agent pane: set by whatever wants to show a
// point in a conversation (a blamed line, a commit's prompt), consumed by the
// transcript once it has that session's turns on screen.

export const transcriptReveal = $state<{ sessionId: string | null; seq: number | null }>({
  sessionId: null,
  seq: null
})

/** Asks the transcript showing `sessionId` to scroll to the turn holding `seq`. */
export function revealTurn(sessionId: string, seq: number): void {
  transcriptReveal.sessionId = sessionId
  transcriptReveal.seq = seq
}

/** Done: the transcript has scrolled to it. */
export function clearReveal(): void {
  transcriptReveal.sessionId = null
  transcriptReveal.seq = null
}
