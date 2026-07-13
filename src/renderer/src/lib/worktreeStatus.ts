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
  const dirty = worktree?.dirty === true

  return {
    waitingPermission,
    waitingDialog,
    agentDone,
    serviceUnhealthy,
    dirty,
    needsAttention: waitingPermission || waitingDialog || serviceUnhealthy
  }
}

// Last agent output line for a worktree, for a one-line activity preview.
export function lastAgentLine(worktreeId: string): string {
  const lines = (store.logs[worktreeId] || []).filter((line) => line.source === 'agent')
  const last = lines[lines.length - 1]
  return last ? last.line : ''
}
