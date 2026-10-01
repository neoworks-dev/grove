// Which session the replay pane is showing. Set by whatever opened it — a
// command, a blame line — and otherwise left to follow the worktree's active
// session. Outside the component so an opener can set it before the pane
// mounts.

export const replayTarget = $state<{ sessionId: string | null; stepIndex: number | null }>({
  sessionId: null,
  stepIndex: null
})

/** Points the replay pane at a session, and at one of its steps when given. */
export function replaySession(sessionId: string, stepIndex: number | null = null): void {
  replayTarget.sessionId = sessionId
  replayTarget.stepIndex = stepIndex
}
