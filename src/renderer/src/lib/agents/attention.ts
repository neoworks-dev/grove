// What a session has to tell you when a turn ends while you are not looking
// at it: it finished, it is waiting on you, or it failed. A turn you stopped
// yourself has nothing to tell.

import type { SessionEvent } from './types'

export type SessionAttention = 'done' | 'needs_you' | 'failed'

/** The attention an event asks for, or null when it asks for none. */
export function attentionOf(event: SessionEvent): SessionAttention | null {
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

/** How each kind reads next to a session, and in a worktree's tooltip. */
export const ATTENTION_LABELS: Record<SessionAttention, string> = {
  done: 'done',
  needs_you: 'needs you',
  failed: 'failed'
}
