// Central IPC surface. Registers every ipcMain.handle channel and pushes
// streamed events (logs, service/agent status) to the renderer. This is the
// single source of truth for the API exposed via preload.

import { ipcMain, dialog, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { WorkbenchConfig, Worktree, DiffFile } from '../shared/types'
import * as git from './git'
import * as config from './config'
import * as files from './files'
import * as search from './search'
import type { SearchMatch } from './search'
import * as extensions from './extensions'
import { LspManager } from './lsp'
import type { LspPosition } from '../shared/types'
import * as worktrees from './worktrees'
import { ServiceSupervisor } from './services'
import { AgentManager, detectAgents, mergeAgents } from './agents'
import { WorktreeWatcher } from './watcher'
import type {
  AgentConfig,
  AgentDialogDecision,
  AgentLaunchOptions,
  PermissionDecision
} from '../shared/types'
import { getRepoState, updateRepoState, setLastRepo, loadState } from './state'
import { SettingsService } from './settings'
import { ActionRunner } from './actions'
import type { SettingScope } from '../shared/settings'

interface Context {
  repoPath: string | null
  config: WorkbenchConfig | null
  worktrees: Worktree[]
}

const context: Context = { repoPath: null, config: null, worktrees: [] }

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
  onDialog: (request) => send('event:agent-dialog', request),
  // Any session/chat change re-persists the whole named-chat map and notifies
  // the renderer so its chat list stays in sync.
  onSession: (worktreeId, name) => {
    send('event:agent-chats', { worktreeId, name, chats: agents.listChats(worktreeId, name) })
    if (!context.repoPath) return
    void updateRepoState(context.repoPath, { agentChats: agents.allChats() })
  }
})

// Persist the named-chat map after a mutation and push it to the renderer.
function persistChats(worktreeId: string, name: string): void {
  send('event:agent-chats', { worktreeId, name, chats: agents.listChats(worktreeId, name) })
  if (context.repoPath) void updateRepoState(context.repoPath, { agentChats: agents.allChats() })
}

const watcher = new WorktreeWatcher((change) => send('event:fs-change', change))

const settings = new SettingsService({
  onChange: (snapshot) => send('event:settings-changed', snapshot)
})

const actionRunner = new ActionRunner({
  onLog: (worktreeId, line) =>
    send('event:log', { worktreeId, source: 'service', name: 'keybind', line })
})

// Active ripgrep search (at most one; a new query cancels it).
let currentSearch: { cancel: () => void } | null = null

const lsp = new LspManager({
  onDiagnostics: (uri, diagnostics) => send('event:lsp-diagnostics', { uri, diagnostics })
})

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
  await settings.attachRepo(root)
  // Restore named chats (and migrate legacy tokens) so prior chats resume.
  const repoState = await getRepoState(root)
  agents.loadChats(repoState.agentChats || {})
  agents.loadSessions(repoState.agentSessions || {})
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

  ipcMain.handle('worktrees:remove', async (_e, worktreeId: string, force: boolean) => {
    const { repoPath } = requireRepo()
    const worktree = findWorktree(worktreeId)
    await supervisor.stopAllForWorktree(worktreeId)
    await worktrees.removeWorktree(repoPath, worktree.path, force)
    return refreshWorktrees()
  })

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

  // Compact the active chat (summarize + continue with less context).
  ipcMain.handle(
    'agents:compact',
    (_e, worktreeId: string, name: string, instructions?: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const agent = effectiveAgents()[name]
      if (!agent) throw new Error(`unknown agent: ${name}`)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return agents.compact(worktree, name, agent, ports, instructions)
    }
  )

  // New chat: start a fresh active chat (prior chats stay resumable).
  ipcMain.handle('agents:reset', async (_e, worktreeId: string, name: string) => {
    const worktree = findWorktree(worktreeId)
    const chat = await agents.resetSession(worktree, name)
    return chat
  })

  // Replay the active chat's transcript (restore after restart).
  ipcMain.handle('agents:transcript', (_e, worktreeId: string, name: string) => {
    const worktree = findWorktree(worktreeId)
    const active = agents.listChats(worktreeId, name).activeId
    return agents.readTranscript(worktree.path, name, active)
  })

  // List the named chats for a worktree+agent.
  ipcMain.handle('agents:chats', (_e, worktreeId: string, name: string) =>
    agents.listChats(worktreeId, name)
  )

  // Rename a chat so it's easy to find when resuming.
  ipcMain.handle(
    'agents:renameChat',
    (_e, worktreeId: string, name: string, chatId: string, chatName: string) => {
      agents.renameChat(worktreeId, name, chatId, chatName)
      persistChats(worktreeId, name)
    }
  )

  // Switch to a previous chat: stop the current run, activate the target, and
  // return its transcript so the renderer can swap the conversation.
  ipcMain.handle(
    'agents:activateChat',
    async (_e, worktreeId: string, name: string, chatId: string) => {
      await agents.stop(worktreeId, name)
      agents.activateChat(worktreeId, name, chatId)
      persistChats(worktreeId, name)
      const worktree = findWorktree(worktreeId)
      return agents.readTranscript(worktree.path, name, chatId)
    }
  )

  // Answer an interactive tool-permission request.
  ipcMain.handle('agents:respondPermission', (_e, id: string, decision: PermissionDecision) =>
    agents.respondPermission(id, decision)
  )

  // Answer a blocking agent dialog (e.g. a question).
  ipcMain.handle('agents:respondDialog', (_e, id: string, decision: AgentDialogDecision) =>
    agents.respondDialog(id, decision)
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

  ipcMain.handle('files:create', (_e, worktreeId: string, relPath: string) => {
    const worktree = findWorktree(worktreeId)
    return files.createFile(worktree.path, relPath)
  })

  ipcMain.handle('files:createDir', (_e, worktreeId: string, relPath: string) => {
    const worktree = findWorktree(worktreeId)
    return files.createDir(worktree.path, relPath)
  })

  ipcMain.handle('files:rename', (_e, worktreeId: string, fromRel: string, toRel: string) => {
    const worktree = findWorktree(worktreeId)
    return files.renamePath(worktree.path, fromRel, toRel)
  })

  ipcMain.handle('files:delete', (_e, worktreeId: string, relPath: string) => {
    const worktree = findWorktree(worktreeId)
    return files.removePath(worktree.path, relPath)
  })

  // ── Content search (ripgrep) ──────────────────────────────────
  // One search at a time: a new query cancels the previous. Matches stream to
  // the renderer in small batches tagged with the request id.
  ipcMain.handle('search:ripgrep', (_e, worktreeId: string, query: string, reqId: string) => {
    const worktree = findWorktree(worktreeId)
    currentSearch?.cancel()
    currentSearch = null
    if (!query.trim()) {
      send('event:search-done', { reqId })
      return
    }
    let batch: SearchMatch[] = []
    const flush = (): void => {
      if (batch.length === 0) return
      send('event:search-result', { reqId, matches: batch })
      batch = []
    }
    const timer = setInterval(flush, 60)
    const handle = search.ripgrepSearch(
      worktree.path,
      query,
      (match) => {
        batch.push(match)
        if (batch.length >= 100) flush()
      },
      () => {
        clearInterval(timer)
        flush()
        send('event:search-done', { reqId })
        currentSearch = null
      }
    )
    currentSearch = {
      cancel: () => {
        clearInterval(timer)
        handle.cancel()
      }
    }
  })

  ipcMain.handle('search:cancel', () => {
    currentSearch?.cancel()
    currentSearch = null
  })

  // ── Extensions (grammars / themes / LSP) ──────────────────────
  ipcMain.handle('extensions:catalog', () => extensions.listCatalog())
  ipcMain.handle('extensions:installed', () => extensions.listInstalled())
  ipcMain.handle('extensions:install', (_e, id: string) => extensions.install(id))
  ipcMain.handle('extensions:uninstall', (_e, id: string) => extensions.uninstall(id))
  ipcMain.handle('extensions:setEnabled', (_e, id: string, enabled: boolean) =>
    extensions.setEnabled(id, enabled)
  )
  ipcMain.handle('extensions:grammar', (_e, id: string) => extensions.readGrammar(id))

  // ── LSP ───────────────────────────────────────────────────────
  ipcMain.handle(
    'lsp:ensure',
    (_e, worktreeId: string, language: string, uri: string, text: string) => {
      const worktree = findWorktree(worktreeId)
      return lsp.ensure(worktreeId, worktree.path, language, uri, text)
    }
  )
  ipcMain.handle(
    'lsp:didChange',
    (_e, worktreeId: string, language: string, uri: string, version: number, text: string) =>
      lsp.didChange(worktreeId, language, uri, version, text)
  )
  ipcMain.handle(
    'lsp:completion',
    (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
      lsp.completion(worktreeId, language, uri, position)
  )
  ipcMain.handle(
    'lsp:hover',
    (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
      lsp.hover(worktreeId, language, uri, position)
  )

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

  // ── Keybind actions ───────────────────────────────────────────
  ipcMain.handle(
    'actions:runShell',
    (_e: IpcMainInvokeEvent, worktreeId: string, commandLine: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      actionRunner.run(worktree, commandLine, ports)
    }
  )

  // ── Settings ──────────────────────────────────────────────────
  void settings.loadUser()
  ipcMain.handle('settings:read', () => settings.snapshot())
  ipcMain.handle(
    'settings:set',
    async (_e: IpcMainInvokeEvent, key: string, value: unknown, scope: SettingScope) => {
      const snapshot = await settings.set(key, value, scope)
      // Broadcast so every window (and future ones) stays coherent.
      send('event:settings-changed', snapshot)
      return snapshot
    }
  )
  ipcMain.handle('settings:openFile', (_e: IpcMainInvokeEvent, scope: SettingScope) => {
    const path = settings.openPath(scope)
    if (!path) return
    return shell.openPath(path)
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
  lsp.stopAll()
  settings.close()
  actionRunner.stopAll()
}
