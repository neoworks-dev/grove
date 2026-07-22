// Central IPC surface. Registers every ipcMain.handle channel and pushes
// streamed events (logs, service/agent status) to the renderer. This is the
// single source of truth for the API exposed via preload.

import { app, ipcMain, dialog, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { access } from 'fs/promises'
import { join } from 'path'
import type {
  WorkbenchConfig,
  Worktree,
  DiffFile,
  OpenPrOptions,
  MergePrOptions,
  InlineHunk
} from '../shared/types'
import * as git from './git'
import { CheckpointManager } from './checkpoints'
import * as inlineDiff from './inlineDiff'
import * as github from './github'
import * as config from './config'
import * as files from './files'
import * as extensions from './extensions'
import { LspManager } from './lsp'
import type { LspPosition, LspRange, LspDiagnostic } from '../shared/types'
import type { CodeAction, Diagnostic } from 'vscode-languageserver-protocol'
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
import { TerminalManager } from './terminals'
import { NeovimManager } from './nvim'
import { buildWorktreeEnv, spawnEnv } from './env'
import {
  PermissionBroker,
  PermissionError,
  type PermissionDecision as PluginPermissionDecision
} from './api/broker'
import { clientFromPlugin, type ClientRecord } from './api/clients'
import type { PluginPermission } from '../shared/plugins'
import { RouteRegistry } from './api/registry'
import { ApiDispatcher } from './api/dispatcher'
import { registerWorkspaceRoutes } from './api/routes/workspace'
import { registerAiRoutes } from './api/routes/ai'
import { registerStorageRoutes } from './api/routes/storage'
import { registerEventRoutes } from './api/routes/events'
import { registerEditorRoutes } from './api/routes/editor'
import { registerGitRoutes } from './api/routes/git'
import { registerLanguagesRoutes } from './api/routes/languages'
import { registerServicesRoutes } from './api/routes/services'
import { registerAgentsRoutes } from './api/routes/agents'
import { registerTerminalsRoutes, type TerminalsTap } from './api/routes/terminals'
import { DocumentRegistry } from './editorDocs'
import { EventHub } from './api/events'
import { VersionCounter } from './api/versions'
import { AppPairing } from './api/socket/pairing'
import { ApiSocketServer } from './api/socket/server'
import { createHash } from 'crypto'
import { PluginRegistry } from './plugins/loader'
import { AiBridge } from './plugins/aiBridge'
import { registerPluginProtocol } from './plugins/protocol'
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
  // Deferred lookups: aiBridge is constructed further down (it needs the
  // plugin registry) but only runs when an agent starts.
  pluginAi: {
    mcpServers: () => aiBridge.buildMcpServers(),
    systemAppend: () => aiBridge.systemAppend()
  },
  onStatus: (runtime) => {
    send('event:agent-status', runtime)
    eventHub.publish({
      topic: 'agents.didChangeStatus',
      payload: runtime,
      worktreeId: runtime.worktreeId
    })
  },
  onLog: (worktreeId, name, chatId, line) => {
    send('event:log', { worktreeId, source: 'agent', name, chatId, line })
    eventHub.publish({ topic: 'agents.log', payload: { worktreeId, name, chatId, line }, worktreeId })
  },
  onPermission: (request) => send('event:agent-permission', request),
  onDialog: (request) => send('event:agent-dialog', request),
  // Any session/chat change re-persists the whole named-chat map and notifies
  // the renderer so its chat list stays in sync.
  onSession: (worktreeId, name) => {
    send('event:agent-chats', { worktreeId, name, chats: agents.listChats(worktreeId, name) })
    if (!context.repoPath) return
    void updateRepoState(context.repoPath, { agentChats: agents.allChats() })
  },
  onQueue: (event) => send('event:agent-queue', event),
  onCommands: (event) => {
    send('event:agent-commands', event)
    // Persist so the slash menu is populated before the next session's first run.
    if (context.repoPath) {
      void updateRepoState(context.repoPath, { agentCommands: agents.allCommands() })
    }
  },
  onChat: (message) => send('event:worktree-chat', message),
  onIntroPhase: (worktreeId, chatId, phase) =>
    send('event:intro-phase', { worktreeId, chatId, phase }),
  onCheckpoint: (worktreePath, trigger, ctx) => {
    void checkpoints.snapshot(worktreePath, trigger, ctx).catch(() => {})
  }
})

const checkpoints = new CheckpointManager({
  onChange: (all) => {
    send('event:checkpoints', all)
    if (context.repoPath) void updateRepoState(context.repoPath, { checkpoints: all })
  }
})

// Persist the named-chat map after a mutation and push it to the renderer.
function persistChats(worktreeId: string, name: string): void {
  send('event:agent-chats', { worktreeId, name, chats: agents.listChats(worktreeId, name) })
  if (context.repoPath) void updateRepoState(context.repoPath, { agentChats: agents.allChats() })
}

const watcher = new WorktreeWatcher((change) => {
  send('event:fs-change', change)
  eventHub.publish({ topic: 'files.didChange', payload: change })
  // Any working-tree change can flip git status: advance the generation the
  // git routes hand out as statusVersion.
  gitStatusVersions.bump(change.worktreeId)
})

const settings = new SettingsService({
  onChange: (snapshot) => send('event:settings-changed', snapshot)
})

const actionRunner = new ActionRunner({
  onLog: (worktreeId, line) =>
    send('event:log', { worktreeId, source: 'service', name: 'keybind', line })
})

// API-owned terminals also feed the terminals route module (assigned when
// routes register below).
let terminalsTap: TerminalsTap | null = null

const terminals = new TerminalManager({
  onData: (id, data) => {
    send('event:terminal-data', { id, data })
    terminalsTap?.onData(id, data)
  },
  onExit: (id, exitCode) => {
    send('event:terminal-exit', { id, exitCode })
    terminalsTap?.onExit(id, exitCode)
  },
  onTitle: (id, title) => send('event:terminal-title', { id, title })
})

// Session → worktree tracking so the editor API can pick the canonical
// (most recently active) nvim session for a worktree.
const nvimSessionWorktrees = new Map<string, string | null>()
const lastActiveNvimByWorktree = new Map<string, string>()

function trackNvimActivity(sessionId: string): void {
  const worktreeId = nvimSessionWorktrees.get(sessionId)
  if (worktreeId) lastActiveNvimByWorktree.set(worktreeId, sessionId)
}

function nvimSessionFor(worktreeId: string): string | null {
  const preferred = lastActiveNvimByWorktree.get(worktreeId)
  if (preferred && nvimSessionWorktrees.get(preferred) === worktreeId) return preferred
  for (const [sessionId, sessionWorktree] of nvimSessionWorktrees) {
    if (sessionWorktree === worktreeId) return sessionId
  }
  return null
}

const nvims = new NeovimManager({
  onRedraw: (id, events) => send('event:nvim-redraw', { id, events }),
  onExit: (id, exitCode) => {
    nvimSessionWorktrees.delete(id)
    send('event:nvim-exit', { id, exitCode })
  },
  onNotify: (id, method, args) => {
    editorDocs.handleNotify(nvimSessionWorktrees.get(id) ?? null, method, args)
    send('event:nvim-notify', { id, method, args })
  }
})

const pluginBroker = new PermissionBroker({
  onPermissionRequest: (request) => send('event:plugin-permission', request)
})
const pluginRegistry = new PluginRegistry(pluginBroker)
const aiBridge = new AiBridge({
  broker: pluginBroker,
  registry: pluginRegistry,
  send
})
const eventHub = new EventHub()
const gitStatusVersions = new VersionCounter()
eventHub.registerTopicScope('editor.', 'editor.read')
eventHub.registerTopicScope('git.', 'git.read')
eventHub.registerTopicScope('worktrees.', 'git.read')
eventHub.registerTopicScope('checkpoints.', 'git.read')
eventHub.registerTopicScope('agents.', 'agents.read')
eventHub.registerTopicScope('terminal.', 'terminal.exec')
eventHub.registerTopicScope('services.', 'services.read')

const apiRegistry = new RouteRegistry()
registerWorkspaceRoutes(apiRegistry)
registerAiRoutes(apiRegistry, { aiBridge })
registerStorageRoutes(apiRegistry, {
  storagePath: () => join(app.getPath('userData'), 'plugin-storage.json')
})
const editorDocs = new DocumentRegistry({
  nvim: { request: (id, method, args) => nvims.request(id, method, args) },
  sessionFor: (worktreeId) => nvimSessionFor(worktreeId),
  allSessions: () => {
    const sessions: { sessionId: string; worktreeId: string }[] = []
    for (const [sessionId, worktreeId] of nvimSessionWorktrees) {
      if (worktreeId) sessions.push({ sessionId, worktreeId })
    }
    return sessions
  },
  activeSession: () => {
    for (const [worktreeId, sessionId] of lastActiveNvimByWorktree) {
      if (nvimSessionWorktrees.get(sessionId) === worktreeId) {
        return { sessionId, worktreeId }
      }
    }
    return null
  },
  worktreePathOf: (worktreeId) => findWorktree(worktreeId).path,
  publish: (topic, payload, worktreeId) => eventHub.publish({ topic, payload, worktreeId })
})

registerEventRoutes(apiRegistry, { hub: eventHub })
registerEditorRoutes(apiRegistry, {
  documents: editorDocs,
  openInEditor: (worktreeId, path, line) =>
    send('event:api-open-file', { worktreeId, path, line })
})
registerGitRoutes(apiRegistry, {
  versions: gitStatusVersions,
  hub: eventHub,
  checkpoints,
  repo: () => requireRepo(),
  listWorktrees: () => refreshWorktrees(),
  createWorktree: async (options) => {
    const { repoPath, config: cfg } = requireRepo()
    const created = await worktrees.createWorktree(
      repoPath,
      cfg,
      {
        name: options.branch,
        baseBranch: options.base ?? (await git.currentBranch(repoPath)),
        newBranch: options.branch
      },
      (worktreeId, line) => send('event:log', { worktreeId, source: 'service', name: 'setup', line })
    )
    await refreshWorktrees()
    return created
  },
  removeWorktree: async (worktree) => {
    const { repoPath } = requireRepo()
    await supervisor.stopAllForWorktree(worktree.id)
    await worktrees.removeWorktree(repoPath, worktree.path, false)
    await refreshWorktrees()
  },
  archiveWorktree: async (worktree) => {
    const { repoPath } = requireRepo()
    await supervisor.stopAllForWorktree(worktree.id)
    await worktrees.archiveWorktree(repoPath, worktree.path, {
      branch: worktree.branch,
      deleteBranch: true,
      force: false
    })
    await refreshWorktrees()
  },
  // Native dialog: the calling client cannot see or answer it.
  confirmDangerous: async (title, detail) => {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title,
      message: title,
      detail,
      buttons: ['Cancel', 'Proceed'],
      defaultId: 0,
      cancelId: 0
    })
    return result.response === 1
  }
})
registerServicesRoutes(apiRegistry, {
  listServices: (worktreeId) => {
    const { config: cfg } = requireRepo()
    const worktree = findWorktree(worktreeId)
    const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
    return Object.entries(cfg.services).map(([name, service]) => {
      const live = supervisor.getRuntime(worktreeId, name)
      return live || supervisor.buildIdleRuntime(worktree, name, service, ports)
    })
  },
  startService: (worktreeId, name) => {
    const { config: cfg } = requireRepo()
    const worktree = findWorktree(worktreeId)
    const service = cfg.services[name]
    if (!service) throw new Error(`unknown service: ${name}`)
    const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
    return supervisor.start(worktree, name, service, ports)
  },
  stopService: async (worktreeId, name) => supervisor.stop(worktreeId, name)
})
registerAgentsRoutes(apiRegistry, {
  hub: eventHub,
  agentNames: () => Object.keys(effectiveAgents()),
  listChats: (worktreeId, name) => agents.listChats(worktreeId, name),
  listInstances: (worktreeId) => agents.listInstances(worktreeId),
  listModels: (name) => agents.listModels(name, context.repoPath || process.cwd()),
  isRunning: (worktreeId, name, chatId) => agents.isRunning(worktreeId, name, chatId),
  createInstance: (worktreeId, name, label) => agents.createInstance(worktreeId, name, label),
  send: (worktreeId, name, text, chatId) => {
    const { config: cfg } = requireRepo()
    const worktree = findWorktree(worktreeId)
    const agent = effectiveAgents()[name]
    if (!agent) throw new Error(`unknown agent: ${name}`)
    const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
    return agents.send(worktree, name, agent, ports, text, chatId)
  },
  stop: (worktreeId, name, chatId) => agents.stop(worktreeId, name, chatId, { clearQueue: true }),
  cancelQueued: (worktreeId, name, chatId, queueId) =>
    agents.cancelQueued(worktreeId, name, chatId, queueId),
  readTranscript: (worktree, name, chatId) => agents.readTranscript(worktree.path, name, chatId),
  sendChatAs: (worktreeId, from, text) => agents.sendChatAs(worktreeId, from, text),
  chatHistory: (worktreeId, since) => agents.chatHistory(worktreeId, since)
})
terminalsTap = registerTerminalsRoutes(apiRegistry, {
  create: ({ worktreeId, cols, rows }) => {
    const { config: cfg } = requireRepo()
    const worktree = findWorktree(worktreeId)
    const vars = buildWorktreeEnv(worktree, worktrees.portsForWorktree(cfg, worktree.portSlot))
    if (apiSocketPath) vars.GROVE_SOCK = apiSocketPath
    return terminals.create({ cwd: worktree.path, env: spawnEnv(vars), cols, rows })
  },
  write: (terminalId, data) => terminals.write(terminalId, data),
  resize: (terminalId, cols, rows) => terminals.resize(terminalId, cols, rows),
  kill: (terminalId) => terminals.kill(terminalId),
  announce: (worktreeId, terminalId, clientName) => {
    send('event:log', {
      worktreeId,
      source: 'service',
      name: 'api',
      line: `${clientName} opened terminal ${terminalId}`
    })
    send('event:api-terminal-created', { worktreeId, terminalId, clientName })
  }
})
const apiDispatcher = new ApiDispatcher({
  registry: apiRegistry,
  broker: pluginBroker,
  findWorktree: (worktreeId) => findWorktree(worktreeId)
})

// Host-stamped identity for a worker-transport call; refuses non-ready plugins.
function pluginClient(pluginId: string): ClientRecord {
  const record = pluginRegistry.get(pluginId)
  if (!record || record.status !== 'ready') {
    throw new PermissionError(`plugin not available: ${pluginId}`)
  }
  return clientFromPlugin(record)
}

// ── External app socket ─────────────────────────────────────────
const appPairing = new AppPairing({
  onPairingRequest: (request) => send('event:app-pairing', request)
})
let apiSocketServer: ApiSocketServer | null = null
let apiSocketPath: string | null = null

// Per-profile socket location: unix socket in a 0700 dir under userData;
// a hashed named pipe on Windows (pipes have no fs permissions there — the
// pairing token is the boundary).
function socketPathFor(userData: string): string {
  if (process.platform === 'win32') {
    const hash = createHash('sha256').update(userData).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\grove-${hash}`
  }
  return join(userData, 'sock', 'grove.sock')
}

function startApiSocket(): void {
  const userData = app.getPath('userData')
  apiSocketPath = socketPathFor(userData)
  apiSocketServer = new ApiSocketServer({
    dispatcher: apiDispatcher,
    pairing: appPairing,
    socketPath: apiSocketPath,
    discoveryPath: join(userData, 'grove-api.json'),
    log: (line) => console.warn(line)
  })
  void apiSocketServer.listen().catch((error: Error) => {
    apiSocketServer = null
    apiSocketPath = null
    console.error('api socket failed to start:', error.message)
  })
}

const lsp = new LspManager({
  onDiagnostics: (uri, diagnostics) => send('event:lsp-diagnostics', { uri, diagnostics })
})
// Registered here (not with the other route modules) because it needs the
// LspManager instance above.
registerLanguagesRoutes(apiRegistry, { lsp, documents: editorDocs })

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

// Serializable plugin list for the renderer host.
function pluginList(): unknown[] {
  return pluginRegistry.list().map((record) => ({
    id: record.id,
    manifest: record.manifest,
    source: record.source,
    status: record.status,
    errors: record.errors
  }))
}

async function refreshWorktrees(): Promise<Worktree[]> {
  const { repoPath, config: cfg } = requireRepo()
  context.worktrees = await worktrees.listWithPorts(repoPath, cfg)
  return context.worktrees
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// Any agent-instruction file at the repo root suppresses the intro page.
async function hasAgentsFile(root: string): Promise<boolean> {
  if (await pathExists(join(root, 'AGENTS.md'))) return true
  return pathExists(join(root, 'CLAUDE.md'))
}

// Open a repo: validate, load config, remember it, list worktrees.
async function openRepo(repoPath: string): Promise<{
  info: { path: string; name: string; currentBranch: string; hasAgentsFile: boolean }
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
  await pluginRegistry.loadAll(root)
  send('event:plugins-changed', pluginList())
  // Restore named chats (and migrate legacy tokens) so prior chats resume.
  const repoState = await getRepoState(root)
  agents.loadChats(repoState.agentChats || {})
  agents.loadSessions(repoState.agentSessions || {})
  // Last-known slash commands populate the menu before the first run.
  agents.loadCommands(repoState.agentCommands || {})
  checkpoints.hydrate(repoState.checkpoints || {})
  const list = await refreshWorktrees()
  return {
    info: {
      path: root,
      name: root.split('/').pop() || root,
      currentBranch: await git.currentBranch(root),
      hasAgentsFile: await hasAgentsFile(root)
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

  ipcMain.handle('git:diffHunks', (_e, worktreeId: string, file: DiffFile) => {
    const worktree = findWorktree(worktreeId)
    return git.diffHunks(worktree.path, file)
  })

  ipcMain.handle('git:diffStats', (_e, worktreeId: string) => {
    const worktree = findWorktree(worktreeId)
    return git.diffStats(worktree.path)
  })

  // ── Local-only checkpoints ──────────────────────────────────────
  ipcMain.handle('checkpoints:list', (_e, worktreeId: string) => {
    const worktree = findWorktree(worktreeId)
    return checkpoints.list(worktree.path)
  })

  ipcMain.handle('checkpoints:snapshot', (_e, worktreeId: string, note?: string) => {
    const worktree = findWorktree(worktreeId)
    return checkpoints.snapshot(worktree.path, 'manual', { note })
  })

  ipcMain.handle('checkpoints:restore', (_e, worktreeId: string, commit: string) => {
    const worktree = findWorktree(worktreeId)
    return checkpoints.restore(worktree.path, commit)
  })

  // ── Inline agent edit (per-hunk accept/reject) ──────────────────
  ipcMain.handle(
    'git:beginInlineReview',
    async (_e, worktreeId: string, relPath: string, snapshot: string) => {
      const worktree = findWorktree(worktreeId)
      const hunks = await inlineDiff.diffSnapshot(worktree.path, relPath, snapshot)
      const ranges = inlineDiff.rebuildWithAccepted(
        snapshot,
        hunks,
        hunks.map(() => true)
      ).ranges
      return { hunks, ranges }
    }
  )

  ipcMain.handle(
    'git:applyInlineReview',
    (
      _e,
      worktreeId: string,
      relPath: string,
      snapshot: string,
      hunks: InlineHunk[],
      applied: boolean[]
    ) => {
      const worktree = findWorktree(worktreeId)
      return inlineDiff.applyInlineReview(worktree.path, relPath, snapshot, hunks, applied)
    }
  )

  // Unified diff between two in-memory file versions, for previewing a pending
  // Write/Edit inline in the permission card.
  ipcMain.handle('git:diffText', (_e, worktreeId: string, before: string, after: string) => {
    const worktree = findWorktree(worktreeId)
    return inlineDiff.diffStrings(worktree.path, before, after)
  })

  // ── Git ship-it chain (stage → commit → push → merge → archive) ──
  ipcMain.handle('git:stage', (_e, worktreeId: string, paths: string[]) => {
    const worktree = findWorktree(worktreeId)
    return git.stage(worktree.path, paths)
  })

  ipcMain.handle('git:unstage', (_e, worktreeId: string, paths: string[]) => {
    const worktree = findWorktree(worktreeId)
    return git.unstage(worktree.path, paths)
  })

  ipcMain.handle('git:commit', (_e, worktreeId: string, message: string) => {
    const worktree = findWorktree(worktreeId)
    return git.commit(worktree.path, message)
  })

  ipcMain.handle('git:push', (_e, worktreeId: string) => {
    const worktree = findWorktree(worktreeId)
    return git.push(worktree.path)
  })

  // Local merge runs in the main worktree (repoPath), merging the feature
  // worktree's branch into baseBranch.
  ipcMain.handle('git:mergeLocal', (_e, worktreeId: string, baseBranch: string) => {
    const { repoPath } = requireRepo()
    const worktree = findWorktree(worktreeId)
    return git.mergeToBase(repoPath, worktree.branch, baseBranch)
  })

  // ── Worktree-into-worktree merge ────────────────────────────────
  ipcMain.handle(
    'git:mergePreview',
    async (_e, targetWorktreeId: string, sourceWorktreeId: string) => {
      const target = findWorktree(targetWorktreeId)
      const source = findWorktree(sourceWorktreeId)
      const preview = await git.mergePreview(target.path, source.branch)
      return { ...preview, sourceDirty: await git.isDirty(source.path) }
    }
  )

  ipcMain.handle(
    'git:mergeWorktree',
    async (
      _e,
      targetWorktreeId: string,
      sourceWorktreeId: string,
      opts: { mode: import('../shared/types').MergeMode; message?: string }
    ) => {
      const target = findWorktree(targetWorktreeId)
      const source = findWorktree(sourceWorktreeId)
      if (target.isDetached) {
        throw new Error(
          `target worktree "${target.name}" is on a detached HEAD; cannot merge into it`
        )
      }
      if (await git.isDirty(target.path)) {
        throw new Error(
          `target worktree "${target.name}" has uncommitted changes; commit or revert them before merging`
        )
      }
      // Snapshot the target before the merge so a bad result is one restore away.
      await checkpoints.snapshot(target.path, 'pre-merge', {
        note: `merge ${source.branch} → ${target.branch}`
      })
      return git.mergeWorktree(target.path, source.branch, opts)
    }
  )

  ipcMain.handle('git:mergeAbort', (_e, targetWorktreeId: string) => {
    const target = findWorktree(targetWorktreeId)
    return git.abortMerge(target.path)
  })

  ipcMain.handle('git:mergeContinue', (_e, targetWorktreeId: string) => {
    const target = findWorktree(targetWorktreeId)
    return git.continueMerge(target.path)
  })

  ipcMain.handle('git:mergeConflicts', (_e, targetWorktreeId: string) => {
    const target = findWorktree(targetWorktreeId)
    return git.conflictedFiles(target.path)
  })

  ipcMain.handle('github:openPr', (_e, worktreeId: string, options: OpenPrOptions) => {
    const worktree = findWorktree(worktreeId)
    return github.openPr(worktree.path, options)
  })

  ipcMain.handle('github:mergePr', (_e, worktreeId: string, options: MergePrOptions) => {
    const worktree = findWorktree(worktreeId)
    return github.mergePr(worktree.path, options)
  })

  ipcMain.handle(
    'worktrees:archive',
    async (_e, worktreeId: string, options: { deleteBranch: boolean; force: boolean }) => {
      const { repoPath } = requireRepo()
      const worktree = findWorktree(worktreeId)
      await supervisor.stopAllForWorktree(worktreeId)
      await worktrees.archiveWorktree(repoPath, worktree.path, {
        branch: worktree.branch,
        deleteBranch: options.deleteBranch,
        force: options.force
      })
      return refreshWorktrees()
    }
  )

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
  // Every spawned instance in a worktree (running + idle chats), each keyed by
  // its chatId. The adapter picker uses agents:configs, not this list.
  ipcMain.handle('agents:list', (_e, worktreeId: string) => agents.listInstances(worktreeId))

  // Spawn a fresh idle instance (chat) of an adapter without touching siblings.
  ipcMain.handle(
    'agents:createInstance',
    (_e, worktreeId: string, name: string, label?: string) => {
      const chat = agents.createInstance(worktreeId, name, label)
      persistChats(worktreeId, name)
      return chat
    }
  )

  // Move a tab to a different adapter (fresh session, kept title).
  ipcMain.handle(
    'agents:convertInstance',
    (_e, worktreeId: string, fromName: string, toName: string, chatId: string) => {
      const moved = agents.convertInstance(worktreeId, fromName, toName, chatId)
      if (moved) {
        persistChats(worktreeId, fromName)
        persistChats(worktreeId, toName)
      }
      return moved
    }
  )

  // Delete an instance (chat) and its transcript.
  ipcMain.handle(
    'agents:deleteChat',
    async (_e, worktreeId: string, name: string, chatId: string) => {
      await agents.deleteChat(worktreeId, name, chatId)
      persistChats(worktreeId, name)
    }
  )

  ipcMain.handle(
    'agents:start',
    (_e, worktreeId: string, name: string, options: AgentLaunchOptions, chatId?: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const agent = effectiveAgents()[name]
      if (!agent) throw new Error(`unknown agent: ${name}`)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return agents.start(worktree, name, agent, ports, options || {}, true, chatId)
    }
  )

  // User-initiated stop: also flushes queued messages back to the composer.
  ipcMain.handle('agents:stop', (_e, worktreeId: string, name: string, chatId: string) =>
    agents.stop(worktreeId, name, chatId, { clearQueue: true })
  )

  // Message typed while a run is active: inject live, queue, or start a
  // resumed run when idle.
  ipcMain.handle(
    'agents:send',
    (_e, worktreeId: string, name: string, text: string, chatId?: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const agent = effectiveAgents()[name]
      if (!agent) throw new Error(`unknown agent: ${name}`)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return agents.send(worktree, name, agent, ports, text, chatId)
    }
  )

  ipcMain.handle('agents:queue', (_e, worktreeId: string, name: string, chatId: string) =>
    agents.getQueue(worktreeId, name, chatId)
  )

  ipcMain.handle(
    'agents:cancelQueued',
    (_e, worktreeId: string, name: string, chatId: string, id: string) =>
      agents.cancelQueued(worktreeId, name, chatId, id)
  )

  // Provider-discovered slash commands (claude); [] for other adapters.
  ipcMain.handle('agents:commands', (_e, worktreeId: string, name: string) =>
    agents.getCommands(worktreeId, name)
  )

  // Model list for one adapter, fetched from its SDK (claude/opencode); [] when
  // the adapter has no model-list API (codex).
  ipcMain.handle('agents:models', (_e, name: string) =>
    agents.listModels(name, context.repoPath || process.cwd())
  )

  // Compact an instance (summarize + continue with less context).
  ipcMain.handle(
    'agents:compact',
    (_e, worktreeId: string, name: string, instructions?: string, chatId?: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const agent = effectiveAgents()[name]
      if (!agent) throw new Error(`unknown agent: ${name}`)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return agents.compact(worktree, name, agent, ports, instructions, chatId)
    }
  )

  // New chat: start a fresh active chat (prior chats stay resumable).
  ipcMain.handle('agents:reset', async (_e, worktreeId: string, name: string, chatId?: string) => {
    const worktree = findWorktree(worktreeId)
    const chat = await agents.resetSession(worktree, name, chatId)
    return chat
  })

  // Replay an instance's transcript (restore after restart / switch instance).
  ipcMain.handle('agents:transcript', (_e, worktreeId: string, name: string, chatId?: string) => {
    const worktree = findWorktree(worktreeId)
    const target = chatId || agents.listChats(worktreeId, name).activeId
    return agents.readTranscript(worktree.path, name, target)
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

  // Switch the active/default instance and return its transcript. Instances run
  // concurrently, so switching no longer stops any run.
  ipcMain.handle(
    'agents:activateChat',
    async (_e, worktreeId: string, name: string, chatId: string) => {
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

  // ── Shared worktree chat (agent↔agent + agent↔user) ─────────────
  ipcMain.handle('chat:send', (_e, worktreeId: string, text: string) => {
    findWorktree(worktreeId)
    return agents.sendChat(worktreeId, text)
  })

  ipcMain.handle('chat:history', (_e, worktreeId: string, since?: number) => {
    findWorktree(worktreeId)
    return agents.chatHistory(worktreeId, since)
  })

  // ── Files ─────────────────────────────────────────────────────
  ipcMain.handle('files:listDir', (_e, worktreeId: string, relPath: string) => {
    const worktree = findWorktree(worktreeId)
    return files.listDir(worktree.path, relPath)
  })

  ipcMain.handle('files:listAll', (_e, worktreeId: string) => {
    const worktree = findWorktree(worktreeId)
    return files.listAll(worktree.path)
  })

  // Arbitrary-directory listing for @ path completion (may leave the worktree).
  ipcMain.handle('files:listPath', (_e, worktreeId: string, rawPath: string) => {
    const worktree = findWorktree(worktreeId)
    return files.listPath(worktree.path, rawPath)
  })

  ipcMain.handle('files:read', (_e, worktreeId: string, absPath: string) => {
    const worktree = findWorktree(worktreeId)
    return files.readFileContent(worktree.path, absPath)
  })

  ipcMain.handle('files:write', (_e, worktreeId: string, absPath: string, content: string) => {
    const worktree = findWorktree(worktreeId)
    return files.writeFileContent(worktree.path, absPath, content)
  })

  // Save a pasted/dropped attachment for @-mentioning in the agent prompt.
  ipcMain.handle(
    'files:saveAttachment',
    (_e, worktreeId: string, data: Uint8Array, ext: string) => {
      const worktree = findWorktree(worktreeId)
      return files.saveAttachment(worktree.path, data, ext)
    }
  )

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
  ipcMain.handle(
    'lsp:definition',
    (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
      lsp.definition(worktreeId, language, uri, position)
  )
  ipcMain.handle(
    'lsp:references',
    (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
      lsp.references(worktreeId, language, uri, position)
  )
  ipcMain.handle(
    'lsp:implementation',
    (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
      lsp.implementation(worktreeId, language, uri, position)
  )
  ipcMain.handle(
    'lsp:typeDefinition',
    (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
      lsp.typeDefinition(worktreeId, language, uri, position)
  )
  ipcMain.handle(
    'lsp:declaration',
    (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
      lsp.declaration(worktreeId, language, uri, position)
  )
  ipcMain.handle(
    'lsp:rename',
    (
      _e,
      worktreeId: string,
      language: string,
      uri: string,
      position: LspPosition,
      newName: string
    ) => lsp.rename(worktreeId, language, uri, position, newName)
  )
  ipcMain.handle(
    'lsp:formatting',
    (_e, worktreeId: string, language: string, uri: string, tabSize: number) =>
      lsp.formatting(worktreeId, language, uri, tabSize)
  )
  ipcMain.handle(
    'lsp:codeAction',
    (
      _e,
      worktreeId: string,
      language: string,
      uri: string,
      range: LspRange,
      diagnostics: LspDiagnostic[]
      // severity is a plain number over IPC; identical to DiagnosticSeverity.
    ) => lsp.codeAction(worktreeId, language, uri, range, diagnostics as unknown as Diagnostic[])
  )
  ipcMain.handle(
    'lsp:resolveCodeAction',
    (_e, worktreeId: string, language: string, action: CodeAction) =>
      lsp.resolveCodeAction(worktreeId, language, action)
  )
  ipcMain.handle(
    'lsp:executeCommand',
    (_e, worktreeId: string, language: string, command: string, args: unknown[]) =>
      lsp.executeCommand(worktreeId, language, command, args)
  )
  ipcMain.handle(
    'lsp:inlayHints',
    (_e, worktreeId: string, language: string, uri: string, range: LspRange) =>
      lsp.inlayHints(worktreeId, language, uri, range)
  )

  // ── Terminal ──────────────────────────────────────────────────
  // Spawn a shell in the worktree's directory with its WT_*/PORT_n vars, so a
  // terminal matches what services and keybind actions see.
  ipcMain.handle('terminal:create', (_e, worktreeId: string | null, cols: number, rows: number) => {
    let cwd = context.repoPath ?? process.cwd()
    let vars: Record<string, string> = {}
    if (worktreeId) {
      const worktree = findWorktree(worktreeId)
      const cfg = requireRepo().config
      vars = buildWorktreeEnv(worktree, worktrees.portsForWorktree(cfg, worktree.portSlot))
      cwd = worktree.path
    }
    // Tools launched inside Grove terminals discover the local API socket
    // with zero config.
    if (apiSocketPath) vars.GROVE_SOCK = apiSocketPath
    return terminals.create({ cwd, env: spawnEnv(vars), cols, rows })
  })
  ipcMain.handle('terminal:write', (_e, id: string, data: string) => terminals.write(id, data))
  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_e, id: string) => terminals.kill(id))

  // ── Embedded Neovim ───────────────────────────────────────────
  // A vendored `nvim --embed` per pane, spawned in the worktree with the same
  // WT_*/PORT_n vars as terminals. Redraw batches stream via event:nvim-redraw.
  ipcMain.handle('nvim:spawn', async (_e, worktreeId: string | null) => {
    let cwd = context.repoPath ?? process.cwd()
    let vars: Record<string, string> = {}
    if (worktreeId) {
      const worktree = findWorktree(worktreeId)
      const cfg = requireRepo().config
      vars = buildWorktreeEnv(worktree, worktrees.portsForWorktree(cfg, worktree.portSlot))
      cwd = worktree.path
    }
    const sessionId = await nvims.spawn({ cwd, env: spawnEnv(vars) })
    nvimSessionWorktrees.set(sessionId, worktreeId)
    if (worktreeId && !lastActiveNvimByWorktree.has(worktreeId)) {
      lastActiveNvimByWorktree.set(worktreeId, sessionId)
    }
    return sessionId
  })
  ipcMain.handle('nvim:attach', (_e, id: string, cols: number, rows: number, file?: string) =>
    nvims.attach(id, cols, rows, file)
  )
  ipcMain.handle('nvim:input', (_e, id: string, keys: string) => {
    trackNvimActivity(id)
    nvims.input(id, keys)
  })
  ipcMain.handle(
    'nvim:inputMouse',
    (_e, id: string, button: string, action: string, modifier: string, row: number, col: number) => {
      trackNvimActivity(id)
      nvims.inputMouse(id, button, action, modifier, row, col)
    }
  )
  ipcMain.handle('nvim:resize', (_e, id: string, cols: number, rows: number) =>
    nvims.resize(id, cols, rows)
  )
  ipcMain.handle('nvim:command', (_e, id: string, command: string) => nvims.command(id, command))
  ipcMain.handle('nvim:request', (_e, id: string, method: string, args: unknown[]) =>
    nvims.request(id, method, args)
  )
  ipcMain.handle('nvim:kill', (_e, id: string) => nvims.kill(id))

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

  // ── Plugins ───────────────────────────────────────────────────
  registerPluginProtocol(pluginRegistry)
  void pluginRegistry.loadAll(null)
  ipcMain.handle('plugins:list', () => pluginList())
  ipcMain.handle('plugins:trust', async (_e: IpcMainInvokeEvent, pluginId: string) => {
    const record = pluginRegistry.get(pluginId)
    if (!record || !context.repoPath) return pluginList()
    await pluginBroker.trustProjectPlugin(context.repoPath, record.manifest)
    await pluginRegistry.refresh(pluginId)
    send('event:plugins-changed', pluginList())
    return pluginList()
  })
  ipcMain.handle(
    'plugins:setEnabled',
    async (_e: IpcMainInvokeEvent, pluginId: string, enabled: boolean) => {
      await pluginBroker.setEnabled(pluginId, enabled)
      await pluginRegistry.refresh(pluginId)
      if (!enabled) {
        aiBridge.clearPlugin(pluginId)
        apiDispatcher.cancelAllForClient(`plugin:${pluginId}`)
      }
      send('event:plugins-changed', pluginList())
      return pluginList()
    }
  )
  ipcMain.handle(
    'plugins:invoke',
    (_e: IpcMainInvokeEvent, pluginId: string, callId: string, method: string, params: unknown) => {
      const client = pluginClient(pluginId)
      const emit = (chunk: unknown): void =>
        send('event:plugin-stream', { pluginId, callId, chunk })
      const invoke = (): Promise<unknown> =>
        apiDispatcher.invoke(client, callId, method, params, { transport: 'worker', emit })
      if (!apiRegistry.get(method)?.streaming) return invoke()
      // Streaming wire contract: the invoke promise resolves immediately and
      // completion/errors travel as an end event, matching what the renderer
      // host awaits (mainStreams finish).
      void invoke()
        .then(() => send('event:plugin-stream', { pluginId, callId, end: true }))
        .catch((error: Error) =>
          send('event:plugin-stream', { pluginId, callId, end: true, error: { message: error.message } })
        )
      return null
    }
  )
  ipcMain.handle('plugins:cancel', (_e: IpcMainInvokeEvent, pluginId: string, callId: string) =>
    apiDispatcher.cancel(`plugin:${pluginId}`, callId)
  )
  ipcMain.handle('plugins:cancelAll', (_e: IpcMainInvokeEvent, pluginId: string) => {
    aiBridge.clearPlugin(pluginId)
    apiDispatcher.cancelAllForClient(`plugin:${pluginId}`)
  })
  ipcMain.handle(
    'plugins:respondPermission',
    (_e: IpcMainInvokeEvent, id: string, decision: PluginPermissionDecision) =>
      pluginBroker.respondPermission(id, decision)
  )
  const grantClients = async (): Promise<ClientRecord[]> => {
    const pluginClients = pluginRegistry.list().map(clientFromPlugin)
    const apps = await appPairing.list()
    const appClients: ClientRecord[] = apps.map((record) => ({
      key: `app:${record.appId}`,
      kind: 'app',
      id: record.appId,
      name: record.name,
      source: 'external',
      declaredScopes: record.grantedScopes
    }))
    return [...pluginClients, ...appClients]
  }
  ipcMain.handle('plugins:grants:list', async () => pluginBroker.listGrants(await grantClients()))
  ipcMain.handle(
    'plugins:grants:revoke',
    async (_e: IpcMainInvokeEvent, clientId: string, permission: PluginPermission) => {
      await pluginBroker.revoke(clientId, permission)
      return pluginBroker.listGrants(await grantClients())
    }
  )
  ipcMain.handle(
    'plugins:grants:revokeScope',
    async (_e: IpcMainInvokeEvent, clientId: string, path: string) => {
      await pluginBroker.revokeFsScope(clientId, path)
      return pluginBroker.listGrants(await grantClients())
    }
  )
  ipcMain.handle('plugins:grants:revokeAll', async (_e: IpcMainInvokeEvent, clientId: string) => {
    await pluginBroker.revokeAll(clientId)
    // Revoking everything for an external app also unpairs it.
    if (clientId.startsWith('app:')) {
      const appId = clientId.slice('app:'.length)
      await appPairing.revoke(appId)
      apiSocketServer?.dropClient(clientId)
    }
    return pluginBroker.listGrants(await grantClients())
  })

  // ── External apps ─────────────────────────────────────────────
  startApiSocket()
  ipcMain.handle('apps:list', () => appPairing.list())
  ipcMain.handle('apps:respondPairing', (_e: IpcMainInvokeEvent, id: string, approved: boolean) =>
    appPairing.respondPairing(id, approved)
  )
  ipcMain.handle('apps:revoke', async (_e: IpcMainInvokeEvent, appId: string) => {
    await appPairing.revoke(appId)
    await pluginBroker.revokeAll(`app:${appId}`)
    apiSocketServer?.dropClient(`app:${appId}`)
    return appPairing.list()
  })
  ipcMain.handle(
    'plugins:respondToolCall',
    (_e: IpcMainInvokeEvent, id: string, result: unknown, errorMessage?: string) =>
      aiBridge.respondToolCall(id, result, errorMessage)
  )

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
  await apiSocketServer?.close().catch(() => {})
  await supervisor.stopAll()
  await agents.stopAll()
  await watcher.closeAll()
  lsp.stopAll()
  terminals.killAll()
  nvims.killAll()
  settings.close()
  actionRunner.stopAll()
}
