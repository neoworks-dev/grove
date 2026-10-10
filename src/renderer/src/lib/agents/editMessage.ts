/**
 * Editing a message already sent.
 *
 * The log cannot change what was sent, so an edit is a rewind followed by a new
 * message: `user.branch` takes the conversation back to the event the message hung
 * from, then the edited message is sent in its place. The main process takes the
 * harness's conversation back to the same point; the fold moves the head there,
 * so the old message and everything after it leave the transcript while the log
 * keeps them.
 */

import type { TranscriptState, UserItem } from './transcript'
import type { ClientEventBody, UserContentBlock } from './types'

/**
 * Whether a message can be edited at all: one the agent has taken up, typed as a
 * message rather than run as a command, in a session idle on a harness that can
 * take its conversation back.
 */
export function canEditMessage(item: UserItem, state: TranscriptState, rewind: boolean): boolean {
  if (!rewind) return false
  if (item.pending || item.command === true) return false
  return state.status !== 'running'
}

/**
 * The client events that replace `item` with `text`, sent as one batch so the
 * service rejects both together. The slices and images it carried go with the
 * new text, as the composer would send them.
 */
export function editMessageEvents(
  state: TranscriptState,
  item: UserItem,
  text: string
): ClientEventBody[] {
  const content: UserContentBlock[] = []
  if (text.trim()) content.push({ type: 'text', text })
  content.push(...item.references, ...item.attachments)
  return [
    { type: 'user.branch', fromSeq: rewindTarget(state, item) },
    { type: 'user.message', content }
  ]
}

/** The event the message hung from, which the conversation continues from; 0 for its start. */
export function rewindTarget(state: TranscriptState, item: UserItem): number {
  const parent = state.parentOf.get(item.seq)
  if (parent === undefined) return 0
  return parent
}
