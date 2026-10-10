/**
 * Rewinding a session to one of the prompts sent in it.
 *
 * A rewind can take back the conversation, the worktree, or both. The conversation
 * goes back through `user.branch`, which the harness must support and which refuses
 * a run in flight; the worktree goes back to the snapshot taken when the prompt was
 * sent. The menu that offers these lives in the agent pane; what it lists, what it
 * allows and what it sends is decided here.
 */

import { rewindTarget } from './editMessage'
import { visibleItems, type TranscriptState, type UserItem } from './transcript'
import type { ClientEventBody } from './types'

/** What a rewind puts back. */
export type RewindChoice = 'both' | 'conversation' | 'code'

/** What the confirmation says before the worktree is touched. */
export const RESTORE_CODE_WARNING =
  'Every file in this worktree goes back to how it was when you sent this prompt, including changes you made yourself since then. A snapshot is taken first so you can undo this.'

/** The prompts a session can be rewound to: typed by the user, taken up by the agent, oldest first. */
export function rewindPrompts(state: TranscriptState): UserItem[] {
  const prompts: UserItem[] = []
  for (const item of visibleItems(state)) {
    if (item.kind !== 'user') continue
    if (item.command === true) continue
    prompts.push(item)
  }
  return prompts
}

export interface RewindState {
  /** The harness can take its conversation back. */
  harnessRewinds: boolean
  /** The agent is mid-turn. */
  running: boolean
  /** A snapshot was taken when the prompt was sent. */
  hasSnapshot: boolean
  /** How many files restoring the worktree would change. */
  changedFileCount: number
}

export interface RewindAvailability {
  conversation: boolean
  code: boolean
  both: boolean
  /** Why the conversation cannot be taken back, or null when it can. */
  conversationReason: string | null
  /** Why the worktree cannot be put back, or null when it can. */
  codeReason: string | null
}

/** Which choices a prompt offers, and for each one that is closed, why. */
export function rewindAvailability(state: RewindState): RewindAvailability {
  const conversationReason = conversationBlocker(state)
  const codeReason = codeBlocker(state)
  return {
    conversation: conversationReason === null,
    code: codeReason === null,
    both: conversationReason === null && codeReason === null,
    conversationReason,
    codeReason
  }
}

/** Why the conversation cannot be taken back right now, or null. */
function conversationBlocker(state: RewindState): string | null {
  if (state.running) return 'Stop the agent first.'
  if (!state.harnessRewinds) return 'This harness cannot take a conversation back.'
  return null
}

/** Why the worktree cannot be put back right now, or null. */
function codeBlocker(state: RewindState): string | null {
  if (state.running) return 'Stop the agent first.'
  if (!state.hasSnapshot) return 'No snapshot was taken for this prompt.'
  if (state.changedFileCount === 0) return 'The worktree already matches this prompt.'
  return null
}

/** Whether a choice takes the conversation back. */
export function restoresConversation(choice: RewindChoice): boolean {
  return choice !== 'code'
}

/** Whether a choice puts the worktree back. */
export function restoresCode(choice: RewindChoice): boolean {
  return choice !== 'conversation'
}

/** The events that take the conversation back to before `prompt`. */
export function rewindConversationEvents(
  state: TranscriptState,
  prompt: UserItem
): ClientEventBody[] {
  return [{ type: 'user.branch', fromSeq: rewindTarget(state, prompt) }]
}
