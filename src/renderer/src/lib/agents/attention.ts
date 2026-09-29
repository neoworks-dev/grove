// What a session has to tell you while you are not looking at it: it finished,
// it is waiting on you, or it failed. A turn you stopped yourself has nothing
// to tell.
//
// Waiting on you mostly happens mid-turn: a call parked on an approval arrives
// as a tool use marked `ask` while the turn is still running.

import type { SessionEvent } from './types'

export type SessionAttention = 'done' | 'needs_you' | 'failed'

/** The attention an event asks for, or null when it asks for none. */
export function attentionOf(event: SessionEvent): SessionAttention | null {
  if (isApprovalRequest(event)) {
    return 'needs_you'
  }
  if (event.type === 'session.status_terminated') {
    return 'failed'
  }
  if (event.type !== 'session.status_idle') {
    return null
  }
  if (event.stopReason === 'end_turn') {
    return 'done'
  }
  if (event.stopReason === 'requires_action') {
    return 'needs_you'
  }
  if (event.stopReason === 'error') {
    return 'failed'
  }
  return null
}

/**
 * Folds one event into a session's flag, returning the flag it should show
 * afterwards (undefined for none). `parked` holds the session's calls waiting
 * on an approval and is updated in place, so "needs you" comes down once the
 * last of them is answered, from wherever it was answered.
 */
export function foldAttention(
  flag: SessionAttention | undefined,
  parked: Set<string>,
  event: SessionEvent
): SessionAttention | undefined {
  if (event.type === 'session.status_running') {
    return undefined
  }
  if (isApprovalRequest(event)) {
    parked.add(event.request.toolCall.toolCallId)
    return 'needs_you'
  }
  const settled = settledApproval(event)
  if (settled !== null) {
    parked.delete(settled)
    if (flag === 'needs_you' && parked.size === 0) {
      return undefined
    }
    return flag
  }
  if (event.type === 'session.status_idle' || event.type === 'session.status_terminated') {
    parked.clear()
  }
  const attention = attentionOf(event)
  if (attention === null) {
    return flag
  }
  return attention
}

/** Whether the event parks a call until the user approves or denies it. */
export function isApprovalRequest(
  event: SessionEvent
): event is Extract<SessionEvent, { type: 'permission' }> {
  return event.type === 'permission'
}

/**
 * The call an event takes off the approval queue: answered, or finished some
 * other way. Null for any other event.
 */
export function settledApproval(event: SessionEvent): string | null {
  if (event.type === 'user.tool_confirmation') {
    return event.toolUseId
  }
  if (event.type !== 'update' || event.update.sessionUpdate !== 'tool_call_update') {
    return null
  }
  const status = event.update.status
  if (status === 'completed' || status === 'failed') {
    return event.update.toolCallId
  }
  return null
}

/** How each kind reads next to a session, and in a worktree's tooltip. */
export const ATTENTION_LABELS: Record<SessionAttention, string> = {
  done: 'done',
  needs_you: 'needs you',
  failed: 'failed'
}
