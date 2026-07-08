// JSON persistence in the OS app-data dir. Keyed per repo so port-slot
// assignments and open tabs survive worktree removal and app restarts.
// Running services/agents are never assumed alive across restarts.

import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import type { InstalledExtension, AgentChats } from '../shared/types'

export type { InstalledExtension }

export interface RepoState {
  portSlots: Record<string, number> // worktreeId -> slot
  openTabs: string[] // absolute file paths
  activeTabPath: string | null
  selectedWorktreeId: string | null
  setupOnceDone: boolean
  agentSessions: Record<string, string> // legacy: "worktreeId::agent" -> token
  agentChats: Record<string, AgentChats> // "worktreeId::agent" -> named chats
  // UI layout (restored on repo open).
  paneSizes: Record<string, number> // pane key -> px
  panelsOpen: Record<string, boolean> // panel key -> open
  centerView: string | null
  activeView: string | null // active sidebar view (activity bar)
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
    paneSizes: {},
    panelsOpen: {},
    centerView: null,
    activeView: null
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
