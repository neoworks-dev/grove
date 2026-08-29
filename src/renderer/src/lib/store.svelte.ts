// Central reactive app state (Svelte 5 runes). Holds repo/worktree selection,
// per-worktree service runtimes, streamed logs, and open editor tabs.
// Components read from here and call window.workbench, then push updates back.
//
// Agent state is deliberately absent: sessions, transcripts and approvals belong
// to the embedded nib server and are held by lib/nib/sessions.svelte.ts.

import type {
  Worktree,
  WorkbenchConfig,
  ServiceRuntime,
  RepoInfo,
  BranchList,
  DiffStats,
  ReviewBatch,
  WorktreeChatMessage
} from '../../../shared/types'

export interface LogLine {
  source: 'service'
  name: string
  line: string
}

import { currentPackName, setIconPack } from './icons'
import { currentThemeName, applyThemeVars, themeFor } from './themes'
import type { ColorTheme } from './themes'
import { layout } from './layout.svelte'
import { settings } from './settings.svelte'
import { nibSessions } from './nib/sessions.svelte'
import { inlineEdit } from './inlineEdit.svelte'
import { review } from './review.svelte'
import { intro } from './intro.svelte'
import { allNvimSessions } from './nvim/registry'
import { setup } from './setup.svelte'

export interface EditorTab {
  worktreeId: string
  path: string // absolute file path, or a synthetic `scratch://…` key
  name: string
  pinned?: boolean
  // A non-file scratch buffer (batch rename, etc.), backed by an nvim buffer
  // rather than a path on disk. Not persisted across sessions.
  scratch?: boolean
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

  // Worktrees with a running agent session, so file changes stream in even when
  // the worktree is not selected. Read straight off the nib session listing —
  // a worktree's id is its path, which is what a session records as its
  // workspace root.
  get activeAgentWorktrees(): string[] {
    const running = nibSessions.list.filter((session) => session.status === 'running')
    return [...new Set(running.map((session) => session.workspaceRoot))]
  }

  // A pending insertion into the agent composer (e.g. an @file:lines reference
  // built from the editor selection). AgentPane consumes it by nonce and clears
  // the field; the nonce distinguishes repeat inserts of identical text.
  composerInsert = $state<{ text: string; nonce: number } | null>(null)

  // Bumped per worktree on any file change, so trees/diffs re-read reactively.
  fsVersion = $state<Record<string, number>>({})

  // Added/removed line counts vs HEAD, keyed by worktreeId. Refreshed on
  // worktree list load and on file changes, shown in the worktree overviews.
  diffStats = $state<Record<string, DiffStats>>({})

  // Worktrees with agent output the user hasn't looked at yet (agent produced
  // output while that worktree wasn't selected). Cleared on selecting it.
  unread = $state<Record<string, boolean>>({})

  // Shared per-worktree chat messages (agent↔agent + agent↔user), keyed by
  // worktreeId.
  worktreeChat = $state<Record<string, WorktreeChatMessage[]>>({})

  // A request from the agents overview/sidebar to show a specific agent session
  // in the Agent pane. The pane consumes it once its worktree matches, then
  // clears it.
  requestedAgent = $state<{ worktreeId: string; sessionId?: string } | null>(null)

  // Set by the fs watcher when a running agent edits a file → the Git Changes
  // sidebar highlights it.
  requestedDiffFile = $state<string | null>(null)

  // Set when opening a file at a specific line (ripgrep search) → the editor
  // scrolls the cursor there once the file is loaded.
  revealTarget = $state<{ path: string; line: number } | null>(null)

  // One-shot request to expand/select a worktree-relative path in the file
  // explorer (breadcrumb clicks); the explorer consumes and clears it.
  explorerRevealPath = $state<string | null>(null)

  // Streamed logs keyed by worktreeId.
  logs = $state<Record<string, LogLine[]>>({})

  // Open editor tabs and the active tab are scoped per worktree, so each
  // worktree keeps its own set of open buffers (not synced across worktrees).
  // `tabs`/`activeTabPath` are accessors over the selected worktree's slice, so
  // every existing call site keeps working unchanged.
  tabsByWorktree = $state<Record<string, EditorTab[]>>({})
  activeTabByWorktree = $state<Record<string, string | null>>({})

  get tabs(): EditorTab[] {
    const id = this.selectedWorktreeId
    if (!id) return []
    return this.tabsByWorktree[id] || []
  }

  set tabs(value: EditorTab[]) {
    const id = this.selectedWorktreeId
    if (!id) return
    this.tabsByWorktree = { ...this.tabsByWorktree, [id]: value }
  }

  get activeTabPath(): string | null {
    const id = this.selectedWorktreeId
    if (!id) return null
    const value = this.activeTabByWorktree[id]
    return value === undefined ? null : value
  }

  set activeTabPath(value: string | null) {
    const id = this.selectedWorktreeId
    if (!id) return
    this.activeTabByWorktree = { ...this.activeTabByWorktree, [id]: value }
  }

  // Active icon pack name; reading this in a component makes icons re-render
  // reactively when the pack changes.
  iconPack = $state<string>(currentPackName())

  // Active color theme name; reading it makes theme-dependent UI (Monaco) react.
  colorTheme = $state<string>(currentThemeName())

  loading = $state(false)
  error = $state<string | null>(null)

  // Active theme (name + scheme + palette). Reading `colorTheme` here makes
  // theme-dependent views react to theme changes.
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

  // Register a file that the already-mounted editor entered itself (`gd`,
  // `:edit`, tag jumps). Unlike openTab this must not drive the layout back into
  // the editor: nvim is already there and only Grove's tab model needs catching up.
  attachEditorTab(tab: EditorTab): void {
    const tabs = this.tabsByWorktree[tab.worktreeId] ?? []
    if (!tabs.some((existing) => existing.path === tab.path)) {
      this.tabsByWorktree = { ...this.tabsByWorktree, [tab.worktreeId]: [...tabs, tab] }
    }
    this.activeTabByWorktree = { ...this.activeTabByWorktree, [tab.worktreeId]: tab.path }
  }

  openTab(tab: EditorTab): void {
    this.attachEditorTab(tab)
    layout.showCenterPane(preferredEditorPane())
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

// Opened files always go to the Neovim center pane — the only editor.
function preferredEditorPane(): string {
  return 'nvim'
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

// Queue text for insertion into the agent composer at its caret. AgentPane
// picks it up reactively (mounting it first via the caller's ensurePane).
let composerInsertNonce = 0
export function insertIntoComposer(text: string): void {
  composerInsertNonce += 1
  store.composerInsert = { text, nonce: composerInsertNonce }
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

// ── Actions ───────────────────────────────────────────────────

export async function openRepoResult(result: {
  info: RepoInfo
  worktrees: Worktree[]
}): Promise<void> {
  store.repo = result.info
  store.worktrees = result.worktrees
  store.config = await window.workbench.config.load()
  store.branches = await window.workbench.git.branches().catch(() => null)
  const repoState = await window.workbench.state.getRepo()
  const restored = repoState.selectedWorktreeId
  store.selectedWorktreeId =
    restored && result.worktrees.some((worktree) => worktree.id === restored)
      ? restored
      : result.worktrees[0]?.id || null
  // Restore UI layout (split tree — or the legacy pane sizes — and open tabs).
  layout.apply(repoState)
  restoreTabs(repoState)
  if (store.selectedWorktreeId) {
    await refreshRuntimes(store.selectedWorktreeId)
  }
  syncWatched()
  // Unconfigured workspace and never dismissed: offer the setup wizard in the
  // left sidebar. introDismissed is honoured too, so a repo that finished the
  // AGENTS.md flow before the wizard existed is not nagged about it again.
  const needsSetup = !result.info.hasConfig || !result.info.hasAgentsFile
  const dismissed = repoState.setupDismissed || repoState.introDismissed
  if (needsSetup && !dismissed) {
    await setup.begin()
    layout.ensurePane('setup')
  }
}

// Rebuild the per-worktree open-tab maps from persisted state, preferring the
// per-worktree form and migrating the legacy flat openTabs (assigned to the
// selected worktree, matching the old single-list behavior).
function restoreTabs(repoState: {
  openTabsByWorktree?: Record<string, string[]>
  activeTabByWorktree?: Record<string, string | null>
  openTabs?: string[]
  activeTabPath?: string | null
  selectedWorktreeId?: string | null
}): void {
  const toTab = (worktreeId: string, path: string): EditorTab => ({
    worktreeId,
    path,
    name: path.split('/').pop() || path
  })

  if (repoState.openTabsByWorktree) {
    const tabs: Record<string, EditorTab[]> = {}
    for (const [worktreeId, paths] of Object.entries(repoState.openTabsByWorktree)) {
      tabs[worktreeId] = paths.map((path) => toTab(worktreeId, path))
    }
    store.tabsByWorktree = tabs
    store.activeTabByWorktree = { ...(repoState.activeTabByWorktree || {}) }
    return
  }

  // Legacy: a single flat list belonged to the selected worktree.
  const worktreeId = store.selectedWorktreeId
  if (!worktreeId || !repoState.openTabs || repoState.openTabs.length === 0) return
  store.tabsByWorktree = {
    [worktreeId]: repoState.openTabs.map((path) => toTab(worktreeId, path))
  }
  const active =
    repoState.activeTabPath && repoState.openTabs.includes(repoState.activeTabPath)
      ? repoState.activeTabPath
      : repoState.openTabs[repoState.openTabs.length - 1]
  store.activeTabByWorktree = { [worktreeId]: active }
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
  for (const worktree of store.worktrees) void refreshDiffStats(worktree.id)
}

// Fetch +/- line counts vs HEAD for one worktree into the store.
export async function refreshDiffStats(worktreeId: string): Promise<void> {
  try {
    const stats = await window.workbench.git.diffStats(worktreeId)
    store.diffStats = { ...store.diffStats, [worktreeId]: stats }
  } catch {
    // A worktree may be mid-removal; ignore transient failures.
  }
}

// Coalesce bursts of file changes into a single diff-stat refresh per worktree.
const diffStatTimers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleDiffStats(worktreeId: string): void {
  const existing = diffStatTimers.get(worktreeId)
  if (existing) clearTimeout(existing)
  diffStatTimers.set(
    worktreeId,
    setTimeout(() => {
      diffStatTimers.delete(worktreeId)
      void refreshDiffStats(worktreeId)
    }, 400)
  )
}

export async function selectWorktree(worktreeId: string): Promise<void> {
  store.selectedWorktreeId = worktreeId
  // Selecting a worktree marks its agent output as seen.
  if (store.unread[worktreeId]) store.unread = { ...store.unread, [worktreeId]: false }
  await window.workbench.state.update({ selectedWorktreeId: worktreeId })
  await refreshRuntimes(worktreeId)
  void refreshDiffStats(worktreeId)
  syncWatched()
}

// Select a worktree and ask the Agent pane to show one of its sessions.
export async function focusAgentInPane(worktreeId: string, sessionId?: string): Promise<void> {
  await selectWorktree(worktreeId)
  store.requestedAgent = { worktreeId, sessionId }
}

export async function refreshRuntimes(worktreeId: string): Promise<void> {
  const services = await window.workbench.services.list(worktreeId)
  store.services = { ...store.services, [worktreeId]: services }
}

// Subscribe to streamed main-process events. Call once at app start.
export function subscribeEvents(): void {
  window.workbench.on('event:log', (payload) => {
    const event = payload as {
      worktreeId: string
      source: 'service'
      name: string
      line: string
    }
    store.appendLog(event.worktreeId, {
      source: event.source,
      name: event.name,
      line: event.line
    })
  })
  window.workbench.on('event:service-status', (payload) => {
    store.updateServiceRuntime(payload as ServiceRuntime)
  })
  window.workbench.on('event:agent-review', (payload) => {
    review.receive(payload as ReviewBatch)
  })
  window.workbench.on('event:agent-review-staged', (payload) => {
    const event = payload as { worktreeId: string; count: number }
    review.setStaged(event.worktreeId, event.count)
  })
  window.workbench.on('event:worktree-chat', (payload) => {
    const message = payload as WorktreeChatMessage
    const list = store.worktreeChat[message.worktreeId] || []
    store.worktreeChat = { ...store.worktreeChat, [message.worktreeId]: [...list, message] }
    // A message from an agent in a non-selected worktree is unread.
    if (message.from.kind === 'agent' && message.worktreeId !== store.selectedWorktreeId) {
      store.unread = { ...store.unread, [message.worktreeId]: true }
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
    // Refresh the +/- line counts for the worktree overviews (debounced).
    scheduleDiffStats(event.worktreeId)
    const isFile = event.type === 'add' || event.type === 'change' || event.type === 'unlink'
    // Something outside the editor wrote this file — an agent, or a review being
    // applied. Nothing else makes an embedded nvim re-read it, so an open buffer
    // would keep showing the old text and could write it back over the change.
    //
    // The file a review is showing is left alone: its buffer holds the change
    // under review (for a gated one, content that is not on disk at all), and
    // re-reading would drop both that and the markup on top of it.
    const underReview = review.showingPath === event.path
    if ((event.type === 'change' || event.type === 'add') && !underReview) {
      for (const session of allNvimSessions()) void session.refreshFile(event.path)
    }
    // An inline edit under review keeps the change in the editor overlay, so it
    // claims its own writes instead of the changes view taking over.
    if (isFile && inlineEdit.claimFsChange(event.worktreeId, event.relPath)) return
    // An onboarding session shows AGENTS.md / example changes in the intro
    // pane, so the git-changes sidebar must not hijack focus for them.
    if (isFile && intro.claimFsChange(event.worktreeId, event.relPath)) return
    // Otherwise just mark the file in the Git Changes sidebar. Agent writes are
    // staged into a review batch and surfaced as one request when that batch
    // closes, so stealing focus on every individual write would fight it.
    if (isFile && store.activeAgentWorktrees.includes(event.worktreeId)) {
      store.requestedDiffFile = event.relPath
    }
  })
}
