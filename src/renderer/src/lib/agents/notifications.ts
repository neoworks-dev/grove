// Desktop notifications for a turn that ended while grove was not focused. The
// worktrees view flags the same turns inside the app; this is for when nobody is
// looking at the app at all.

import { layout } from '../layout.svelte'
import { selectWorktree, store } from '../store.svelte'
import { getSession } from './api'
import { ATTENTION_LABELS, attentionOf } from './attention'
import { subagentOf } from './sessionTree'
import { agentSessions } from './sessions.svelte'
import type { SessionEvent, SessionMeta } from './types'

/**
 * Shows a desktop notification for a turn that ended while grove's window is not
 * focused, saying which session and how it ended. Clicking it opens that session.
 */
export async function notifyTurnEnded(event: SessionEvent): Promise<void> {
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
  // A subagent's session ends with its tool call; the session that spawned it
  // is the one that has something to say.
  if (!session || subagentOf(session)) {
    return
  }
  const notification = new Notification(session.title, {
    body: `${ATTENTION_LABELS[attention]} · ${worktreeName(session)}`,
    tag: session.id
  })
  notification.onclick = () => void openSession(session)
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
