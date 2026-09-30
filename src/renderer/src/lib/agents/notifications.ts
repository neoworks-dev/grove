// Desktop notifications for a turn that ended, or a call waiting on an
// approval, while grove was not focused. The worktrees view flags the same
// sessions inside the app; this is for when nobody is looking at the app at all.

import { layout } from '../layout.svelte'
import { selectWorktree, store } from '../store.svelte'
import { getSession } from './api'
import { ATTENTION_LABELS, attentionOf, isApprovalRequest, settledApproval } from './attention'
import { subagentOf } from './sessionTree'
import { agentSessions } from './sessions.svelte'
import type { SessionEvent, SessionMeta } from './types'

// The notification each session has up for an approval, taken down once the
// approval is answered so it can't send you to a question that is gone.
const approvalNotifications = new Map<string, Notification>()

/**
 * Shows a desktop notification for a session that has something to say while
 * grove's window is not focused: which session, and whether it finished, failed
 * or is waiting on you. Clicking it opens that session.
 */
export async function notifyAttention(event: SessionEvent): Promise<void> {
  if (settledApproval(event) !== null) {
    closeApprovalNotification(event.sessionId)
    return
  }
  if (document.hasFocus()) {
    return
  }
  const attention = attentionOf(event)
  if (!attention) {
    return
  }
  // Fetched rather than read off the session list, which only catches up on the
  // title a session gets from its first prompt at its next poll.
  const session = await getSession(event.sessionId).catch(() => null)
  if (!session) {
    return
  }
  // A subagent's turn ends with its tool call, so the session that spawned it
  // is the one with something to say. An approval it waits on is its own.
  const approval = isApprovalRequest(event)
  if (subagentOf(session) && !approval) {
    return
  }
  const notification = new Notification(session.title, {
    body: `${ATTENTION_LABELS[attention]} · ${worktreeName(session)}`,
    tag: session.id
  })
  notification.onclick = () => void openSession(session)
  if (approval) {
    approvalNotifications.set(session.id, notification)
  }
}

/**
 * Takes down the session's approval notification once nothing in it waits on
 * you any more. Reads the flag `noteEvent` has already updated for this event.
 */
function closeApprovalNotification(sessionId: string): void {
  const notification = approvalNotifications.get(sessionId)
  if (!notification || agentSessions.attention[sessionId] === 'needs_you') {
    return
  }
  approvalNotifications.delete(sessionId)
  notification.close()
}

/** The name the worktrees view shows for the session's worktree. */
function worktreeName(session: SessionMeta): string {
  const worktree = store.worktrees.find((candidate) => candidate.path === session.workspaceRoot)
  if (!worktree) {
    return session.workspaceRoot
  }
  return worktree.name
}

/** Raises grove and shows the session in the Agent pane. */
async function openSession(session: SessionMeta): Promise<void> {
  await window.workbench.raiseWindow()
  agentSessions.setActive(session.workspaceRoot, session.id)
  await selectWorktree(session.workspaceRoot)
  layout.ensurePane('agent')
}
