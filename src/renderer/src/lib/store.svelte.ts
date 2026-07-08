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
  PermissionDecision,
  AgentDialogRequest,
  AgentDialogDecision,
  AgentChats
} from '../../../shared/types'

export interface LogLine {
  source: 'service' | 'agent'
  name: string
  line: string
}

import { currentPackName, setIconPack } from './icons'
import { currentThemeName, applyThemeVars, themeFor } from './themes'
import type { ColorTheme } from './themes'
import { layout } from './layout.svelte'
import { settings } from './settings.svelte'

export interface EditorTab {
  worktreeId: string
  path: string // absolute
  name: string
  pinned?: boolean
}

const MAX_LOG_LINES = 2000

class WorkbenchStore {
  repo = $state<RepoInfo | null>(null)
  worktrees = $state<Worktree[]>([])
  selectedWorktreeId = $state<string | null>(null)
  config = $state<WorkbenchConfig | null>(null)
  branches = $state<BranchList | null>(null)

  // Per-worktree runtime keyed by worktreeId.
  services = $state<Record<string, ServiceRuntime[]>>({})
  agents = $state<Record<string, AgentRuntime[]>>({})
  activeAgentWorktrees = $state<string[]>([])
  // Named chats keyed by "worktreeId::agent".
  agentChats = $state<Record<string, AgentChats>>({})

  // Effective agent configs (detected + config) keyed by agent name.
  agentConfigs = $state<Record<string, AgentConfig>>({})

  // Bumped per worktree on any file change, so trees/diffs re-read reactively.
  fsVersion = $state<Record<string, number>>({})

  // Set by the fs watcher when a running agent edits a file → DiffPane focuses it.
  requestedDiffFile = $state<string | null>(null)

  // Set when opening a file at a specific line (ripgrep search) → EditorPane
  // scrolls the cursor there once the file is loaded.
  revealTarget = $state<{ path: string; line: number } | null>(null)

  // Pending interactive tool-permission requests (agent → user).
  pendingPermissions = $state<PermissionRequestEvent[]>([])

  // Pending blocking dialogs (e.g. agent questions) awaiting an answer.
  pendingDialogs = $state<AgentDialogRequest[]>([])

  // A proposed (not-yet-applied) file change from a pending Write/Edit, shown in
  // the diff editor so the user reviews before approving.
  proposedDiff = $state<{
    path: string
    original: string
    modified: string
    language: string
  } | null>(null)

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

  // Active theme (name + scheme + palette) for the CodeMirror editor/diff views.
  // Reading `colorTheme` here makes those views react to theme changes.
  get activeTheme(): ColorTheme {
    return themeFor(this.colorTheme)
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
    layout.showCenterPane('editor')
  }

  closeTab(path: string): void {
    this.tabs = this.tabs.filter((tab) => tab.path !== path)
    if (this.activeTabPath === path) {
      this.activeTabPath = this.tabs.length > 0 ? this.tabs[this.tabs.length - 1].path : null
    }
  }

  // ── Buffer operations (leader b menu) ──────────────────────────
  // "Buffer" is just an open editor tab. Bulk closes act within the buffer's
  // own worktree and never touch pinned buffers.
  togglePin(path: string): void {
    this.tabs = this.tabs.map((tab) => (tab.path === path ? { ...tab, pinned: !tab.pinned } : tab))
  }

  private worktreeTabs(worktreeId: string): EditorTab[] {
    return this.tabs.filter((tab) => tab.worktreeId === worktreeId)
  }

  // Drop the given paths, then keep `keepActive` selected if the old active tab
  // was among those closed.
  private dropTabs(doomed: Set<string>, keepActive: string): void {
    if (doomed.size === 0) return
    this.tabs = this.tabs.filter((tab) => !doomed.has(tab.path))
    if (this.activeTabPath && doomed.has(this.activeTabPath)) {
      this.activeTabPath = this.tabs.some((tab) => tab.path === keepActive) ? keepActive : null
    }
  }

  closeOtherTabs(path: string): void {
    const target = this.tabs.find((tab) => tab.path === path)
    if (!target) return
    const doomed = new Set(
      this.worktreeTabs(target.worktreeId)
        .filter((tab) => tab.path !== path && !tab.pinned)
        .map((tab) => tab.path)
    )
    this.dropTabs(doomed, path)
  }

  closeTabsToSide(path: string, side: 'left' | 'right'): void {
    const target = this.tabs.find((tab) => tab.path === path)
    if (!target) return
    const siblings = this.worktreeTabs(target.worktreeId)
    const index = siblings.findIndex((tab) => tab.path === path)
    if (index < 0) return
    const range = side === 'left' ? siblings.slice(0, index) : siblings.slice(index + 1)
    const doomed = new Set(range.filter((tab) => !tab.pinned).map((tab) => tab.path))
    this.dropTabs(doomed, path)
  }
}

export const store = new WorkbenchStore()

export function applyIconPack(name: string): void {
  setIconPack(name)
  store.iconPack = name
  void settings.set('workbench.iconPack', name, 'user')
}

export function applyColorTheme(name: string): void {
  applyThemeVars(name)
  store.colorTheme = name
  void settings.set('workbench.colorTheme', name, 'user')
}

// Open an absolute file path in the editor (used by the file tree and by agent
// tool cards). Basename becomes the tab label.
export function openFileInEditor(worktreeId: string, path: string): void {
  const name = path.split('/').pop() || path
  store.selectedWorktreeId = worktreeId
  store.openTab({ worktreeId, path, name })
}

// Open a file and reveal a specific line (ripgrep search results).
export function openFileAtLine(worktreeId: string, path: string, line: number): void {
  openFileInEditor(worktreeId, path)
  store.revealTarget = { path, line }
}

// Move between open editor tabs (Shift+hjkl in the editor).
export function switchTab(direction: 'prev' | 'next' | 'first' | 'last'): void {
  const tabs = store.tabs.filter((tab) => tab.worktreeId === store.selectedWorktreeId)
  if (tabs.length === 0) return
  const index = tabs.findIndex((tab) => tab.path === store.activeTabPath)
  let next = index < 0 ? 0 : index
  if (direction === 'prev') next = (next - 1 + tabs.length) % tabs.length
  else if (direction === 'next') next = (next + 1) % tabs.length
  else if (direction === 'first') next = 0
  else next = tabs.length - 1
  store.activeTabPath = tabs[next].path
}

// Seed the in-memory transcript from the persisted on-disk log so a chat
// reappears after an app restart. Caller only invokes this when no agent lines
// exist yet for the worktree.
export function seedAgentTranscript(worktreeId: string, name: string, lines: string[]): void {
  if (lines.length === 0) return
  const entries: LogLine[] = lines.map((line) => ({ source: 'agent', name, line }))
  const current = store.logs[worktreeId] || []
  store.logs = { ...store.logs, [worktreeId]: [...entries, ...current] }
}

// "New chat": reset the agent's continuation server-side and clear its
// transcript + any pending review state from the UI.
export async function resetAgentChat(worktreeId: string, agent: string): Promise<void> {
  await window.workbench.agents.reset(worktreeId, agent)
  const current = store.logs[worktreeId] || []
  store.logs = { ...store.logs, [worktreeId]: current.filter((line) => line.source !== 'agent') }
  store.pendingPermissions = store.pendingPermissions.filter(
    (request) => !(request.worktreeId === worktreeId && request.agent === agent)
  )
  store.proposedDiff = null
}

// "/compact": summarize the conversation and continue with a compacted
// context. The agent runs a compact turn; its output streams into the
// transcript like any other turn (ending in a compact boundary marker).
export async function compactChat(
  worktreeId: string,
  agent: string,
  instructions?: string
): Promise<void> {
  await window.workbench.agents.compact(worktreeId, agent, instructions)
  await refreshRuntimes(worktreeId)
}

// Replace the visible agent transcript with a given set of lines (used when
// switching to another chat). Non-agent log lines for the worktree are kept.
function setAgentTranscript(worktreeId: string, name: string, lines: string[]): void {
  const others = (store.logs[worktreeId] || []).filter((line) => line.source !== 'agent')
  const entries: LogLine[] = lines.map((line) => ({ source: 'agent', name, line }))
  store.logs = { ...store.logs, [worktreeId]: [...entries, ...others] }
}

// Fetch the named-chat list for a worktree+agent into the store.
export async function refreshChats(worktreeId: string, agent: string): Promise<void> {
  const chats = await window.workbench.agents.chats(worktreeId, agent)
  store.agentChats = { ...store.agentChats, [`${worktreeId}::${agent}`]: chats }
}

// Rename a chat so it's easy to find when resuming.
export async function renameChat(
  worktreeId: string,
  agent: string,
  chatId: string,
  chatName: string
): Promise<void> {
  await window.workbench.agents.renameChat(worktreeId, agent, chatId, chatName)
}

// Resume a previous chat: activate it server-side and swap its transcript in.
export async function resumeChat(worktreeId: string, agent: string, chatId: string): Promise<void> {
  const lines = await window.workbench.agents.activateChat(worktreeId, agent, chatId)
  setAgentTranscript(worktreeId, agent, lines)
  store.pendingPermissions = store.pendingPermissions.filter(
    (request) => !(request.worktreeId === worktreeId && request.agent === agent)
  )
  store.proposedDiff = null
}

// Answer a pending permission request and drop it from the queue.
export async function respondPermission(id: string, decision: PermissionDecision): Promise<void> {
  store.pendingPermissions = store.pendingPermissions.filter((request) => request.id !== id)
  store.proposedDiff = null
  await window.workbench.agents.respondPermission(id, decision)
}

// Answer a pending agent dialog (e.g. a question) and drop it from the queue.
export async function respondDialog(id: string, decision: AgentDialogDecision): Promise<void> {
  store.pendingDialogs = store.pendingDialogs.filter((request) => request.id !== id)
  await window.workbench.agents.respondDialog(id, decision)
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  svelte: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'shell',
  toml: 'ini'
}

function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return LANGUAGE_BY_EXT[ext] || 'plaintext'
}

// Apply an Edit-style string replacement the way the agent tools do.
function applyStringEdit(text: string, oldString: string, newString: string, all: boolean): string {
  if (typeof oldString !== 'string' || oldString.length === 0) return text
  return all ? text.split(oldString).join(newString) : text.replace(oldString, newString)
}

// Build a diff of the current file vs. what a pending Write/Edit would produce,
// and surface it in the diff view. No-op for non-file-editing tools.
export async function openProposedDiff(request: PermissionRequestEvent): Promise<void> {
  const path = request.path
  if (!path || !store.selectedWorktreeId) return
  const input = request.input as Record<string, unknown>

  let original = ''
  try {
    original = await window.workbench.files.read(store.selectedWorktreeId, path)
  } catch {
    original = '' // new file
  }

  let modified: string
  if (request.toolName === 'Write' && typeof input.content === 'string') {
    modified = input.content
  } else if (request.toolName === 'Edit') {
    modified = applyStringEdit(
      original,
      input.old_string as string,
      input.new_string as string,
      input.replace_all === true
    )
  } else if (request.toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    modified = (input.edits as Record<string, unknown>[]).reduce(
      (acc, edit) =>
        applyStringEdit(
          acc,
          edit.old_string as string,
          edit.new_string as string,
          edit.replace_all === true
        ),
      original
    )
  } else {
    return // not a file-editing tool
  }

  store.proposedDiff = { path, original, modified, language: languageForPath(path) }
  layout.showCenterPane('diff')
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
  // Restore UI layout (split tree — or the legacy pane sizes — and open tabs).
  layout.apply(repoState)
  if (store.selectedWorktreeId && repoState.openTabs && repoState.openTabs.length > 0) {
    const worktreeId = store.selectedWorktreeId
    store.tabs = repoState.openTabs.map((path) => ({
      worktreeId,
      path,
      name: path.split('/').pop() || path
    }))
    store.activeTabPath =
      repoState.activeTabPath && repoState.openTabs.includes(repoState.activeTabPath)
        ? repoState.activeTabPath
        : repoState.openTabs[repoState.openTabs.length - 1]
  }
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
    const event = payload as {
      worktreeId: string
      source: 'service' | 'agent'
      name: string
      line: string
    }
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
      store.pendingDialogs = store.pendingDialogs.filter(
        (request) => !(request.worktreeId === runtime.worktreeId && request.agent === runtime.name)
      )
      if (store.pendingPermissions.length === 0) store.proposedDiff = null
    }
    void window.workbench.agents.active().then((ids) => {
      store.activeAgentWorktrees = ids
      syncWatched()
    })
  })
  window.workbench.on('event:agent-permission', (payload) => {
    const request = payload as PermissionRequestEvent
    store.pendingPermissions = [...store.pendingPermissions, request]
    // Show a proposed-change diff for file-editing tools so review isn't blind.
    void openProposedDiff(request)
  })
  window.workbench.on('event:agent-dialog', (payload) => {
    store.pendingDialogs = [...store.pendingDialogs, payload as AgentDialogRequest]
  })
  window.workbench.on('event:agent-chats', (payload) => {
    const event = payload as { worktreeId: string; name: string; chats: AgentChats }
    store.agentChats = {
      ...store.agentChats,
      [`${event.worktreeId}::${event.name}`]: event.chats
    }
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
      layout.showCenterPane('diff')
    }
  })
}
