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
import type { BranchPosition, BranchPull, Worktree } from '../../../shared/types'
import type { SessionAttention } from './agents/attention'

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

/** The sessions in a worktree whose turn ended out of sight, with how it ended. */
export function sessionAttentionFor(
  worktreeId: string
): { session: SessionMeta; attention: SessionAttention }[] {
  const flagged: { session: SessionMeta; attention: SessionAttention }[] = []
  for (const session of sessionsFor(worktreeId)) {
    const attention = agentSessions.attention[session.id]
    if (attention) flagged.push({ session, attention })
  }
  return flagged
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
 * A worktree's commits ahead of and behind the base branch, or null when it is
 * level with it or is the base itself.
 */
export function branchPositionFor(worktreeId: string): BranchPosition | null {
  const position = store.branchPositions[worktreeId]
  if (!position) return null
  if (position.ahead === 0 && position.behind === 0) return null
  return position
}

/**
 * The pull request opened from a worktree's branch, or null when it has none.
 * A pull request checked out from the GitHub pane sits on a local `pr-<n>`
 * branch rather than its head branch, so that one is matched by number.
 */
export function pullFor(worktree: Worktree): BranchPull | null {
  if (worktree.isMain || worktree.isDetached) return null
  const pull = store.branchPulls[worktree.branch]
  if (pull) return pull
  const checkedOut = /^pr-(\d+)$/.exec(worktree.branch)
  if (!checkedOut) return null
  const number = Number(checkedOut[1])
  const byNumber = Object.values(store.branchPulls).find((candidate) => candidate.number === number)
  if (!byNumber) return null
  return byNumber
}

/**
 * Whether a worktree's work has landed on the base: its pull request was
 * merged, or its branch's own commits are all on the base already.
 */
export function isMerged(worktree: Worktree): boolean {
  if (worktree.isMain) return false
  const pull = pullFor(worktree)
  if (pull && pull.state === 'MERGED') return true
  const position = store.branchPositions[worktree.id]
  if (!position) return false
  return position.mergedLocally
}

/** How a pull request's checks came out, collapsed to the three a dot can show. */
export function checksOutcome(pull: BranchPull): 'passed' | 'failed' | 'pending' | null {
  if (pull.checks === 'SUCCESS') return 'passed'
  if (pull.checks === 'FAILURE' || pull.checks === 'ERROR') return 'failed'
  if (pull.checks === 'PENDING' || pull.checks === 'EXPECTED') return 'pending'
  return null
}

/** A pull request chip's tooltip: its number, state and checks. */
export function pullTitle(pull: BranchPull): string {
  const parts = [`Pull request #${pull.number}`, pullStateLabel(pull)]
  const outcome = checksOutcome(pull)
  if (outcome) parts.push(`checks ${outcome}`)
  return parts.join(' · ')
}

/** A pull request's state in words, draft included. */
function pullStateLabel(pull: BranchPull): string {
  if (pull.state === 'OPEN' && pull.isDraft) return 'draft'
  return pull.state.toLowerCase()
}

/** A position's tooltip, naming the base it is measured against. */
export function positionTitle(position: BranchPosition): string {
  return `${position.ahead} ahead of, ${position.behind} behind ${position.base}`
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
