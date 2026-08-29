// Shared status colours + per-worktree attention derivation, consumed by both
// the Dashboard and the Agents overview so the two surfaces stay in sync.
//
// Agent signals come from the agent session listing, which is polled centrally by
// the session store — so reading them here inside a Svelte reactive context is
// enough to stay current, with nothing to subscribe to.

import { store } from './store.svelte'
import { agentSessions } from './agents/sessions.svelte'
import { visibleItems, type AgentItem } from './agents/transcript'
import type { SessionMeta } from './agents/types'

export const serviceStatusColor: Record<string, string> = {
  running: 'bg-green',
  starting: 'bg-amber',
  unhealthy: 'bg-red',
  stopped: 'bg-neutral-600'
}

export const agentStatusColor: Record<string, string> = {
  running: 'bg-green',
  idle: 'bg-neutral-600',
  requires_action: 'bg-amber',
  error: 'bg-red'
}

export interface WorktreeAttention {
  waitingPermission: boolean
  agentDone: boolean
  serviceUnhealthy: boolean
  unread: boolean
  dirty: boolean
  needsAttention: boolean
}

/** Agent sessions rooted in a worktree. A worktree's id is its path. */
export function sessionsFor(worktreeId: string): SessionMeta[] {
  return agentSessions.forWorktree(worktreeId)
}

// Derive the attention flags for one worktree from live state. Reading the
// stores inside a Svelte reactive context keeps callers reactive.
export function attentionFor(worktreeId: string): WorktreeAttention {
  const sessions = sessionsFor(worktreeId)
  const services = store.services[worktreeId] || []
  const worktree = store.worktrees.find((entry) => entry.id === worktreeId)

  const waitingPermission = sessions.some((session) => session.pendingApprovals.length > 0)
  const agentDone = sessions.some((session) => session.stopReason === 'error')
  const serviceUnhealthy = services.some((service) => service.status === 'unhealthy')
  const unread = store.unread[worktreeId] === true
  const dirty = worktree?.dirty === true

  return {
    waitingPermission,
    agentDone,
    serviceUnhealthy,
    unread,
    dirty,
    needsAttention: waitingPermission || serviceUnhealthy || unread
  }
}

// Compact "+A −R" diff-stat label for a worktree, or null when there are no
// uncommitted changes. Binary-only changes count as 0 lines.
export function diffStatLabel(worktreeId: string): { added: number; removed: number } | null {
  const stats = store.diffStats[worktreeId]
  if (!stats) return null
  if (stats.added === 0 && stats.removed === 0) return null
  return { added: stats.added, removed: stats.removed }
}

/**
 * The agent's most recent words in a session, for a one-line activity preview.
 *
 * Only a session with a stream open has a transcript to read; the listing alone
 * does not carry message text, and opening a stream just to preview one line
 * would cost a connection per worktree.
 */
export function lastAgentLineFor(sessionId: string): string {
  const live = agentSessions.live[sessionId]
  if (!live) return ''
  const messages = visibleItems(live.transcript).filter(
    (item): item is AgentItem => item.kind === 'agent' && item.text.length > 0
  )
  const last = messages[messages.length - 1]
  if (!last) return ''
  return last.text.split('\n')[0]
}

/** Badge colour for a session row. */
export function sessionStatusColor(session: SessionMeta): string {
  if (session.pendingApprovals.length > 0) return agentStatusColor.requires_action
  if (session.status === 'running') return agentStatusColor.running
  if (session.stopReason === 'error') return agentStatusColor.error
  return agentStatusColor.idle
}
