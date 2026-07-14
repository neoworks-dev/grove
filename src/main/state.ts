// JSON persistence in the OS app-data dir. Keyed per repo so port-slot
// assignments and open tabs survive worktree removal and app restarts.
// Running services/agents are never assumed alive across restarts.

import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import type {
  InstalledExtension,
  AgentChats,
  AgentSlashCommand,
  CheckpointMeta,
  DockLayoutState
} from '../shared/types'

export type { InstalledExtension }

export interface RepoState {
  portSlots: Record<string, number> // worktreeId -> slot
  openTabs: string[] // absolute file paths
  activeTabPath: string | null
  selectedWorktreeId: string | null
  setupOnceDone: boolean
  agentSessions: Record<string, string> // legacy: "worktreeId::agent" -> token
  agentChats: Record<string, AgentChats> // "worktreeId::agent" -> named chats
  // Last-known provider-discovered slash commands, so the menu is populated
  // before the first run of a session.
  agentCommands: Record<string, AgentSlashCommand[]>
  // Local-only working-tree checkpoints, keyed by worktreeId (== worktree path).
  // The git objects live under refs/workbench/** in the repo; this is metadata.
  checkpoints: Record<string, CheckpointMeta[]>
  // Hashes of project-scope shell/ai keybind actions the user has approved
  // (project settings are repo-supplied — running them needs consent).
  trustedActionHashes: string[]
  // UI layout (restored on repo open).
  viewLayouts: Record<string, unknown> // view id -> serialized layout tree
  activeLayoutView: string | null
  // Legacy pre-tree layout fields, kept as migration input. paneSizes still
  // carries sizes for panels nested inside panes (tree, diffList).
  paneSizes: Record<string, number> // pane key -> px
  panelsOpen: Record<string, boolean> // panel key -> open
  centerView: string | null
  activeView: string | null // active sidebar view (activity bar)
  // Docked left/right side panels (outside the moveable split tree) and the
  // distraction-free focus mode that floats the center.
  docks: DockLayoutState | null
  focusMode: boolean
}

export interface AppState {
  lastRepoPath: string | null
  repos: Record<string, RepoState> // repoPath -> state
  extensions: InstalledExtension[]
}

const EMPTY_STATE: AppState = {
  lastRepoPath: null,
  repos: {},
  extensions: []
}

function statePath(): string {
  return join(app.getPath('userData'), 'workbench-state.json')
}

let cache: AppState | null = null

export async function loadState(): Promise<AppState> {
  if (cache) return cache
  let loaded: AppState
  try {
    const text = await readFile(statePath(), 'utf8')
    loaded = { ...EMPTY_STATE, ...JSON.parse(text) }
  } catch {
    loaded = { ...EMPTY_STATE }
  }
  cache = loaded
  return loaded
}

export async function saveState(state: AppState): Promise<void> {
  cache = state
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2), 'utf8')
}

export function emptyRepoState(): RepoState {
  return {
    portSlots: {},
    openTabs: [],
    activeTabPath: null,
    selectedWorktreeId: null,
    setupOnceDone: false,
    agentSessions: {},
    agentChats: {},
    agentCommands: {},
    checkpoints: {},
    trustedActionHashes: [],
    viewLayouts: {},
    activeLayoutView: null,
    paneSizes: {},
    panelsOpen: {},
    centerView: null,
    activeView: null,
    docks: null,
    focusMode: false
  }
}

export async function getRepoState(repoPath: string): Promise<RepoState> {
  const state = await loadState()
  if (!state.repos[repoPath]) {
    state.repos[repoPath] = emptyRepoState()
  }
  return state.repos[repoPath]
}

export async function updateRepoState(
  repoPath: string,
  patch: Partial<RepoState>
): Promise<RepoState> {
  const state = await loadState()
  const current = state.repos[repoPath] || emptyRepoState()
  const next = { ...current, ...patch }
  state.repos[repoPath] = next
  await saveState(state)
  return next
}

export async function setLastRepo(repoPath: string): Promise<void> {
  const state = await loadState()
  state.lastRepoPath = repoPath
  await saveState(state)
}
