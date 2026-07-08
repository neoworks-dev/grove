// Central reactive app state (Svelte 5 runes). Holds repo/worktree selection,
// per-worktree service/agent runtimes, streamed logs, and open editor tabs.
// Components read from here and call window.workbench, then push updates back.

import type {
  Worktree,
  WorkbenchConfig,
  ServiceRuntime,
  AgentRuntime,
  AgentConfig,
  RepoInfo,
  BranchList,
  PermissionRequestEvent,
  PermissionDecision
} from '../../../shared/types'

export interface LogLine {
  source: 'service' | 'agent'
  name: string
  line: string
}

import { currentPackName, setIconPack } from './icons'
import { currentThemeName, applyThemeVars, monacoThemeFor } from './themes'

export interface EditorTab {
  worktreeId: string
  path: string // absolute
  name: string
}

export type CenterView = 'editor' | 'diff' | 'preview' | 'dashboard'

const MAX_LOG_LINES = 2000

class WorkbenchStore {
  repo = $state<RepoInfo | null>(null)
  worktrees = $state<Worktree[]>([])
  selectedWorktreeId = $state<string | null>(null)
  config = $state<WorkbenchConfig | null>(null)
  branches = $state<BranchList | null>(null)
  centerView = $state<CenterView>('editor')

  // Per-worktree runtime keyed by worktreeId.
  services = $state<Record<string, ServiceRuntime[]>>({})
  agents = $state<Record<string, AgentRuntime[]>>({})
  activeAgentWorktrees = $state<string[]>([])

  // Effective agent configs (detected + config) keyed by agent name.
  agentConfigs = $state<Record<string, AgentConfig>>({})

  // Bumped per worktree on any file change, so trees/diffs re-read reactively.
  fsVersion = $state<Record<string, number>>({})

  // Set by the fs watcher when a running agent edits a file → DiffPane focuses it.
  requestedDiffFile = $state<string | null>(null)

  // Pending interactive tool-permission requests (agent → user).
  pendingPermissions = $state<PermissionRequestEvent[]>([])

  // Streamed logs keyed by worktreeId.
  logs = $state<Record<string, LogLine[]>>({})

  tabs = $state<EditorTab[]>([])
  activeTabPath = $state<string | null>(null)

  // Active icon pack name; reading this in a component makes icons re-render
  // reactively when the pack changes.
  iconPack = $state<string>(currentPackName())

  // Active color theme name; reading it makes theme-dependent UI (Monaco) react.
  colorTheme = $state<string>(currentThemeName())

  loading = $state(false)
  error = $state<string | null>(null)

  get monacoTheme(): string {
    return monacoThemeFor(this.colorTheme)
  }

  get selectedWorktree(): Worktree | null {
    return this.worktrees.find((worktree) => worktree.id === this.selectedWorktreeId) || null
  }

  setError(message: string): void {
    this.error = message
  }

  clearError(): void {
    this.error = null
  }

  appendLog(worktreeId: string, entry: LogLine): void {
    const current = this.logs[worktreeId] || []
    const next = [...current, entry]
    if (next.length > MAX_LOG_LINES) {
      next.splice(0, next.length - MAX_LOG_LINES)
    }
    this.logs = { ...this.logs, [worktreeId]: next }
  }

  updateServiceRuntime(runtime: ServiceRuntime): void {
    const list = this.services[runtime.worktreeId] || []
    const next = list.some((service) => service.name === runtime.name)
      ? list.map((service) => (service.name === runtime.name ? runtime : service))
      : [...list, runtime]
    this.services = { ...this.services, [runtime.worktreeId]: next }
  }

  updateAgentRuntime(runtime: AgentRuntime): void {
    const list = this.agents[runtime.worktreeId] || []
    const next = list.some((agent) => agent.name === runtime.name)
      ? list.map((agent) => (agent.name === runtime.name ? runtime : agent))
      : [...list, runtime]
    this.agents = { ...this.agents, [runtime.worktreeId]: next }
  }

  openTab(tab: EditorTab): void {
    if (!this.tabs.some((existing) => existing.path === tab.path)) {
      this.tabs = [...this.tabs, tab]
    }
    this.activeTabPath = tab.path
    this.centerView = 'editor'
  }

  closeTab(path: string): void {
    this.tabs = this.tabs.filter((tab) => tab.path !== path)
    if (this.activeTabPath === path) {
      this.activeTabPath = this.tabs.length > 0 ? this.tabs[this.tabs.length - 1].path : null
    }
  }
}

export const store = new WorkbenchStore()

export function applyIconPack(name: string): void {
  setIconPack(name)
  store.iconPack = name
}

export function applyColorTheme(name: string): void {
  applyThemeVars(name)
  store.colorTheme = name
}

// Open an absolute file path in the editor (used by the file tree and by agent
// tool cards). Basename becomes the tab label.
export function openFileInEditor(worktreeId: string, path: string): void {
  const name = path.split('/').pop() || path
  store.selectedWorktreeId = worktreeId
  store.openTab({ worktreeId, path, name })
}

// Answer a pending permission request and drop it from the queue.
export async function respondPermission(
  id: string,
  decision: PermissionDecision
): Promise<void> {
  store.pendingPermissions = store.pendingPermissions.filter((request) => request.id !== id)
  await window.workbench.agents.respondPermission(id, decision)
}

// ── Actions ───────────────────────────────────────────────────

export async function openRepoResult(result: {
  info: RepoInfo
  worktrees: Worktree[]
}): Promise<void> {
  store.repo = result.info
  store.worktrees = result.worktrees
  store.config = await window.workbench.config.load()
  store.branches = await window.workbench.git.branches().catch(() => null)
  store.agentConfigs = await window.workbench.agents.configs().catch(() => ({}))
  const repoState = await window.workbench.state.getRepo()
  const restored = repoState.selectedWorktreeId
  store.selectedWorktreeId =
    restored && result.worktrees.some((worktree) => worktree.id === restored)
      ? restored
      : result.worktrees[0]?.id || null
  if (store.selectedWorktreeId) {
    await refreshRuntimes(store.selectedWorktreeId)
  }
  syncWatched()
}

// Watch the selected worktree plus any worktree with a running agent, so file
// changes (including agent edits) stream in even when not selected.
export function syncWatched(): void {
  const ids = new Set<string>()
  if (store.selectedWorktreeId) ids.add(store.selectedWorktreeId)
  for (const id of store.activeAgentWorktrees) ids.add(id)
  void window.workbench.fs.watch([...ids])
}

export async function refreshWorktrees(): Promise<void> {
  store.worktrees = await window.workbench.worktrees.list()
}

export async function selectWorktree(worktreeId: string): Promise<void> {
  store.selectedWorktreeId = worktreeId
  await window.workbench.state.update({ selectedWorktreeId: worktreeId })
  await refreshRuntimes(worktreeId)
  syncWatched()
}

export async function refreshRuntimes(worktreeId: string): Promise<void> {
  const [services, agents] = await Promise.all([
    window.workbench.services.list(worktreeId),
    window.workbench.agents.list(worktreeId)
  ])
  store.services = { ...store.services, [worktreeId]: services }
  store.agents = { ...store.agents, [worktreeId]: agents }
  store.activeAgentWorktrees = await window.workbench.agents.active()
}

// Subscribe to streamed main-process events. Call once at app start.
export function subscribeEvents(): void {
  window.workbench.on('event:log', (payload) => {
    const event = payload as { worktreeId: string; source: 'service' | 'agent'; name: string; line: string }
    store.appendLog(event.worktreeId, { source: event.source, name: event.name, line: event.line })
  })
  window.workbench.on('event:service-status', (payload) => {
    store.updateServiceRuntime(payload as ServiceRuntime)
  })
  window.workbench.on('event:agent-status', (payload) => {
    const runtime = payload as AgentRuntime
    store.updateAgentRuntime(runtime)
    // Drop any stale permission prompts once an agent is no longer running.
    if (runtime.status !== 'running') {
      store.pendingPermissions = store.pendingPermissions.filter(
        (request) => !(request.worktreeId === runtime.worktreeId && request.agent === runtime.name)
      )
    }
    void window.workbench.agents.active().then((ids) => {
      store.activeAgentWorktrees = ids
      syncWatched()
    })
  })
  window.workbench.on('event:agent-permission', (payload) => {
    store.pendingPermissions = [...store.pendingPermissions, payload as PermissionRequestEvent]
  })

  window.workbench.on('event:fs-change', (payload) => {
    const event = payload as {
      worktreeId: string
      path: string
      relPath: string
      type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
    }
    // Bump the version so file trees / diff lists re-read.
    store.fsVersion = {
      ...store.fsVersion,
      [event.worktreeId]: (store.fsVersion[event.worktreeId] || 0) + 1
    }
    // If a running agent touched a file, auto-open its diff.
    const isFile = event.type === 'add' || event.type === 'change' || event.type === 'unlink'
    if (isFile && store.activeAgentWorktrees.includes(event.worktreeId)) {
      store.selectedWorktreeId = event.worktreeId
      store.requestedDiffFile = event.relPath
      store.centerView = 'diff'
    }
  })
}
