// Central IPC surface. Registers every ipcMain.handle channel and pushes
// streamed events (logs, service/agent status) to the renderer. This is the
// single source of truth for the API exposed via preload.

import { ipcMain, dialog, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { WorkbenchConfig, Worktree, DiffFile } from '../shared/types'
import * as git from './git'
import * as config from './config'
import * as files from './files'
import * as worktrees from './worktrees'
import { ServiceSupervisor } from './services'
import { AgentManager, detectAgents, mergeAgents } from './agents'
import { WorktreeWatcher } from './watcher'
import type { AgentConfig, AgentLaunchOptions, PermissionDecision } from '../shared/types'
import { getRepoState, updateRepoState, setLastRepo, loadState } from './state'

interface Context {
  repoPath: string | null
  config: WorkbenchConfig | null
  worktrees: Worktree[]
  agentSessions: Record<string, string> // "worktreeId::agent" -> continuation token
}

const context: Context = { repoPath: null, config: null, worktrees: [], agentSessions: {} }

function send(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

const supervisor = new ServiceSupervisor({
  onStatus: (runtime) => send('event:service-status', runtime),
  onLog: (worktreeId, name, line) =>
    send('event:log', { worktreeId, source: 'service', name, line })
})

const agents = new AgentManager({
  onStatus: (runtime) => send('event:agent-status', runtime),
  onLog: (worktreeId, name, line) => send('event:log', { worktreeId, source: 'agent', name, line }),
  onPermission: (request) => send('event:agent-permission', request),
  // Mirror continuation tokens into persisted repo state (empty = reset).
  onSession: (worktreeId, name, token) => {
    if (!context.repoPath) return
    const key = `${worktreeId}::${name}`
    if (token) context.agentSessions[key] = token
    else delete context.agentSessions[key]
    void updateRepoState(context.repoPath, { agentSessions: { ...context.agentSessions } })
  }
})

const watcher = new WorktreeWatcher((change) => send('event:fs-change', change))

function findWorktree(worktreeId: string): Worktree {
  const worktree = context.worktrees.find((entry) => entry.id === worktreeId)
  if (!worktree) throw new Error(`unknown worktree: ${worktreeId}`)
  return worktree
}

function requireRepo(): { repoPath: string; config: WorkbenchConfig } {
  if (!context.repoPath || !context.config) {
    throw new Error('no repository opened')
  }
  return { repoPath: context.repoPath, config: context.config }
}

// Adapter defaults merged with config-defined agents (config overrides).
function effectiveAgents(): Record<string, AgentConfig> {
  const detected = detectAgents()
  const configured = context.config?.agents || {}
  return mergeAgents(detected, configured)
}

async function refreshWorktrees(): Promise<Worktree[]> {
  const { repoPath, config: cfg } = requireRepo()
  context.worktrees = await worktrees.listWithPorts(repoPath, cfg)
  return context.worktrees
}

// Open a repo: validate, load config, remember it, list worktrees.
async function openRepo(repoPath: string): Promise<{
  info: { path: string; name: string; currentBranch: string }
  worktrees: Worktree[]
}> {
  if (!(await git.isGitRepo(repoPath))) {
    throw new Error('not a git repository')
  }
  const root = await git.repoRoot(repoPath)
  context.repoPath = root
  context.config = await config.loadConfig(root)
  await setLastRepo(root)
  // Restore agent continuation tokens so prior chats resume after a restart.
  const repoState = await getRepoState(root)
  context.agentSessions = { ...(repoState.agentSessions || {}) }
  agents.loadSessions(context.agentSessions)
  const list = await refreshWorktrees()
  return {
    info: {
      path: root,
      name: root.split('/').pop() || root,
      currentBranch: await git.currentBranch(root)
    },
    worktrees: list
  }
}

export function registerIpc(): void {
  // ── Repo ──────────────────────────────────────────────────────
  ipcMain.handle('repo:pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return openRepo(result.filePaths[0])
  })

  ipcMain.handle('repo:open', (_e, repoPath: string) => openRepo(repoPath))

  ipcMain.handle('repo:last', async () => {
    const state = await loadState()
    return state.lastRepoPath
  })

  // ── Worktrees ─────────────────────────────────────────────────
  ipcMain.handle('worktrees:list', () => refreshWorktrees())

  ipcMain.handle(
    'worktrees:create',
    async (_e, options: { name: string; baseBranch: string; newBranch?: string }) => {
      const { repoPath, config: cfg } = requireRepo()
      const created = await worktrees.createWorktree(repoPath, cfg, options, (worktreeId, line) =>
        send('event:log', { worktreeId, source: 'service', name: 'setup', line })
      )
      await refreshWorktrees()
      return created
    }
  )

  ipcMain.handle(
    'worktrees:remove',
    async (_e, worktreeId: string, force: boolean) => {
      const { repoPath } = requireRepo()
      const worktree = findWorktree(worktreeId)
      await supervisor.stopAllForWorktree(worktreeId)
      await worktrees.removeWorktree(repoPath, worktree.path, force)
      return refreshWorktrees()
    }
  )

  // ── Git (branches + diff) ─────────────────────────────────────
  ipcMain.handle('git:branches', () => {
    const { repoPath } = requireRepo()
    return git.listBranches(repoPath)
  })

  ipcMain.handle('git:changedFiles', (_e, worktreeId: string) => {
    const worktree = findWorktree(worktreeId)
    return git.changedFiles(worktree.path)
  })

  ipcMain.handle('git:diffSides', (_e, worktreeId: string, file: DiffFile) => {
    const worktree = findWorktree(worktreeId)
    return git.diffSides(worktree.path, file)
  })

  // ── Config ────────────────────────────────────────────────────
  ipcMain.handle('config:load', async () => {
    const { repoPath } = requireRepo()
    context.config = await config.loadConfig(repoPath)
    return context.config
  })

  ipcMain.handle('config:exists', () => {
    const { repoPath } = requireRepo()
    return config.configExists(repoPath)
  })

  ipcMain.handle('config:writeSample', async () => {
    const { repoPath } = requireRepo()
    const written = await config.writeSampleConfig(repoPath)
    context.config = await config.loadConfig(repoPath)
    return written
  })

  // ── Services ──────────────────────────────────────────────────
  ipcMain.handle('services:list', (_e, worktreeId: string) => {
    const { config: cfg } = requireRepo()
    const worktree = findWorktree(worktreeId)
    const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
    return Object.entries(cfg.services).map(([name, service]) => {
      const live = supervisor.getRuntime(worktreeId, name)
      return live || supervisor.buildIdleRuntime(worktree, name, service, ports)
    })
  })

  ipcMain.handle('services:start', (_e, worktreeId: string, name: string) => {
    const { config: cfg } = requireRepo()
    const worktree = findWorktree(worktreeId)
    const service = cfg.services[name]
    if (!service) throw new Error(`unknown service: ${name}`)
    const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
    return supervisor.start(worktree, name, service, ports)
  })

  ipcMain.handle('services:startAll', async (_e, worktreeId: string) => {
    const { config: cfg } = requireRepo()
    const worktree = findWorktree(worktreeId)
    const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
    for (const [name, service] of Object.entries(cfg.services)) {
      await supervisor.start(worktree, name, service, ports)
    }
  })

  ipcMain.handle('services:stop', (_e, worktreeId: string, name: string) =>
    supervisor.stop(worktreeId, name)
  )

  ipcMain.handle('services:stopAll', (_e, worktreeId: string) =>
    supervisor.stopAllForWorktree(worktreeId)
  )

  ipcMain.handle('services:restart', (_e, worktreeId: string, name: string) => {
    const { config: cfg } = requireRepo()
    const worktree = findWorktree(worktreeId)
    const service = cfg.services[name]
    if (!service) throw new Error(`unknown service: ${name}`)
    const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
    return supervisor.start(worktree, name, service, ports)
  })

  // ── Agents ────────────────────────────────────────────────────
  ipcMain.handle('agents:list', (_e, worktreeId: string) => {
    const all = effectiveAgents()
    return Object.entries(all).map(([name, agent]) => {
      const live = agents.getRuntime(worktreeId, name)
      if (live) return live
      return {
        worktreeId,
        name,
        status: 'stopped' as const,
        pid: null,
        command: agent.command,
        exitCode: null,
        logPath: ''
      }
    })
  })

  ipcMain.handle(
    'agents:start',
    (_e, worktreeId: string, name: string, options: AgentLaunchOptions) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const agent = effectiveAgents()[name]
      if (!agent) throw new Error(`unknown agent: ${name}`)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return agents.start(worktree, name, agent, ports, options || {})
    }
  )

  ipcMain.handle('agents:stop', (_e, worktreeId: string, name: string) =>
    agents.stop(worktreeId, name)
  )

  // New chat: drop the continuation token and wipe the transcript.
  ipcMain.handle('agents:reset', (_e, worktreeId: string, name: string) => {
    const worktree = findWorktree(worktreeId)
    return agents.resetSession(worktree, name)
  })

  // Replay the persisted transcript (for restoring a chat after a restart).
  ipcMain.handle('agents:transcript', (_e, worktreeId: string, name: string) => {
    const worktree = findWorktree(worktreeId)
    return agents.readTranscript(worktree.path, name)
  })

  // Answer an interactive tool-permission request.
  ipcMain.handle('agents:respondPermission', (_e, id: string, decision: PermissionDecision) =>
    agents.respondPermission(id, decision)
  )

  ipcMain.handle('agents:active', () => agents.activeWorktreeIds())

  // Effective agent configs (adapter defaults + config) with modes/efforts,
  // for building the launch UI.
  ipcMain.handle('agents:configs', () => effectiveAgents())

  // ── Files ─────────────────────────────────────────────────────
  ipcMain.handle('files:listDir', (_e, worktreeId: string, relPath: string) => {
    const worktree = findWorktree(worktreeId)
    return files.listDir(worktree.path, relPath)
  })

  ipcMain.handle('files:listAll', (_e, worktreeId: string) => {
    const worktree = findWorktree(worktreeId)
    return files.listAll(worktree.path)
  })

  ipcMain.handle('files:read', (_e, worktreeId: string, absPath: string) => {
    const worktree = findWorktree(worktreeId)
    return files.readFileContent(worktree.path, absPath)
  })

  ipcMain.handle('files:write', (_e, worktreeId: string, absPath: string, content: string) => {
    const worktree = findWorktree(worktreeId)
    return files.writeFileContent(worktree.path, absPath, content)
  })

  // ── State ─────────────────────────────────────────────────────
  ipcMain.handle('state:getRepo', () => {
    const { repoPath } = requireRepo()
    return getRepoState(repoPath)
  })

  ipcMain.handle('state:update', (_e, patch: Record<string, unknown>) => {
    const { repoPath } = requireRepo()
    return updateRepoState(repoPath, patch)
  })

  // ── File watching ─────────────────────────────────────────────
  // Watch exactly the given worktrees (selected + those with running agents).
  ipcMain.handle('fs:watch', (_e, worktreeIds: string[]) => {
    const paths = worktreeIds
      .map((id) => context.worktrees.find((worktree) => worktree.id === id)?.path)
      .filter((path): path is string => Boolean(path))
    watcher.setWatched(paths)
  })

  // ── Misc ──────────────────────────────────────────────────────
  ipcMain.handle('shell:openExternal', (_e: IpcMainInvokeEvent, url: string) =>
    shell.openExternal(url)
  )
}

// Clean shutdown: kill every child process.
export async function shutdown(): Promise<void> {
  await supervisor.stopAll()
  await agents.stopAll()
  await watcher.closeAll()
}
