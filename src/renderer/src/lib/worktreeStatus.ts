// Shared status colours + per-worktree attention derivation, consumed by both
// the Dashboard and the Agents overview so the two surfaces stay in sync. All
// attention signals are read from already-push-fed store state (no polling):
// agent status/exit, pending permissions/dialogs, service health, dirty tree.

import { store } from './store.svelte'

export const serviceStatusColor: Record<string, string> = {
  running: 'bg-green',
  starting: 'bg-amber',
  unhealthy: 'bg-red',
  stopped: 'bg-neutral-600'
}

export const agentStatusColor: Record<string, string> = {
  running: 'bg-green',
  exited: 'bg-neutral-600',
  stopped: 'bg-neutral-600',
  error: 'bg-red'
}

export interface WorktreeAttention {
  waitingPermission: boolean
  waitingDialog: boolean
  agentDone: boolean
  serviceUnhealthy: boolean
  unread: boolean
  dirty: boolean
  needsAttention: boolean
}

// Derive the attention flags for one worktree from live store state. Reading the
// store inside a Svelte reactive context keeps callers reactive.
export function attentionFor(worktreeId: string): WorktreeAttention {
  const agents = store.agents[worktreeId] || []
  const services = store.services[worktreeId] || []
  const worktree = store.worktrees.find((entry) => entry.id === worktreeId)

  const waitingPermission = store.pendingPermissions.some(
    (request) => request.worktreeId === worktreeId
  )
  const waitingDialog = store.pendingDialogs.some((request) => request.worktreeId === worktreeId)
  const agentDone = agents.some((agent) => agent.status === 'exited' || agent.status === 'error')
  const serviceUnhealthy = services.some((service) => service.status === 'unhealthy')
  const unread = store.unread[worktreeId] === true
  const dirty = worktree?.dirty === true

  return {
    waitingPermission,
    waitingDialog,
    agentDone,
    serviceUnhealthy,
    unread,
    dirty,
    needsAttention: waitingPermission || waitingDialog || serviceUnhealthy || unread
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

// Last agent output line for a worktree, for a one-line activity preview.
export function lastAgentLine(worktreeId: string): string {
  const lines = (store.logs[worktreeId] || []).filter((line) => line.source === 'agent')
  const last = lines[lines.length - 1]
  return last ? last.line : ''
}

// Last output line for a specific instance in a worktree, for a per-row preview.
export function lastAgentLineFor(worktreeId: string, name: string, chatId?: string): string {
  const lines = (store.logs[worktreeId] || []).filter(
    (line) =>
      line.source === 'agent' &&
      line.name === name &&
      (chatId === undefined || line.chatId === chatId)
  )
  const last = lines[lines.length - 1]
  return last ? last.line : ''
}
