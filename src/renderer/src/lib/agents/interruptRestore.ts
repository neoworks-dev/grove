/**
 * Pressing up on an empty composer right after interrupting the agent.
 *
 * What the user most often wants after stopping a turn is to reword the prompt that
 * started it. The prompt goes back into the composer and the conversation is taken
 * back to before it, in one step; the worktree is left as the interrupted turn made
 * it. The rewind is refused while the run is active, so a stop that has been asked
 * for but has not landed is waited out rather than raced.
 */

import { rewindPrompts } from './rewind'
import type { TranscriptState, UserItem } from './transcript'

export interface InterruptRestoreContext {
  /** The harness can take its conversation back. */
  harnessRewinds: boolean
  /** The user asked to stop the turn in flight, and it has not ended yet. */
  stopRequested: boolean
  /** The turn whose prompt was already put back, so a second press does not go further back. */
  restoredTurn: number
}

/** What pressing up does. */
export type InterruptRestoreAction =
  /** Nothing to do with an interrupt: up steps through history as usual. */
  | { kind: 'none' }
  /** The stop has not landed: restore once the turn has ended. */
  | { kind: 'wait' }
  /** The turn was interrupted: put this prompt back and take the conversation back before it. */
  | { kind: 'restore'; prompt: UserItem }

/** The prompt of the turn that was just interrupted, or null when the last turn ended any other way. */
export function interruptedPrompt(state: TranscriptState, restoredTurn: number): UserItem | null {
  if (state.status !== 'idle' || state.stopReason !== 'aborted') return null
  if (state.turnStartSeq === restoredTurn) return null
  const prompts = rewindPrompts(state)
  const latest = prompts[prompts.length - 1]
  if (latest === undefined) return null
  // The message that started a turn lands before the turn's own start.
  if (latest.seq > state.turnStartSeq) return null
  return latest
}

/** Decides what up on an empty composer should do, given where the interrupt stands. */
export function interruptRestoreAction(
  state: TranscriptState,
  context: InterruptRestoreContext
): InterruptRestoreAction {
  if (!context.harnessRewinds) return { kind: 'none' }
  if (state.status === 'running') {
    if (context.stopRequested) return { kind: 'wait' }
    return { kind: 'none' }
  }
  const prompt = interruptedPrompt(state, context.restoredTurn)
  if (prompt === null) return { kind: 'none' }
  return { kind: 'restore', prompt }
}
