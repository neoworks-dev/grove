// Central IPC surface. Registers every ipcMain.handle channel and pushes
// streamed events (logs, service/agent status) to the renderer. This is the
// single source of truth for the API exposed via preload.

import { app, ipcMain, dialog, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { access } from 'fs/promises'
import { join } from 'path'
import type { Context } from '@neoworks/extension-system'
import { mainContext } from './kernel/context'
import type {
  WorkbenchConfig,
  Worktree,
  DiffFile,
  OpenPrOptions,
  MergePrOptions,
  InlineHunk,
  RepoInfo,
  ServiceConfig
} from '../shared/types'
import * as git from './git'
import { CheckpointManager } from './checkpoints'
import * as inlineDiff from './inlineDiff'
import * as github from './github'
import * as config from './config'
import { detectServices } from './detect'
import * as files from './files'
import * as editorCatalog from './editorCatalog'
import { LspManager } from './lsp'
import type { LspPosition, LspRange, LspDiagnostic } from '../shared/types'
import type { CodeAction, Diagnostic } from 'vscode-languageserver-protocol'
import * as worktrees from './worktrees'
import { ServiceSupervisor } from './services'
import { WorktreeWatcher } from './watcher'
import { WorktreeChannel } from './worktreeChannel'
import { ReviewService } from './review'
import type { HunkDecision } from '../shared/types'
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
import { registerDebugRoutes } from './api/routes/debug'
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
import { NibServer } from './nib/server'
import { registerNibProtocol } from './nib/protocol'
import { NibReviewBridge, NIB_AGENT } from './nib/reviewBridge'
import { NibClient } from './nib/client'
import type { SettingScope } from '../shared/settings'

interface RepoContext {
  repoPath: string | null
  config: WorkbenchConfig | null
  worktrees: Worktree[]
}

const context: RepoContext = { repoPath: null, config: null, worktrees: [] }

// The listener shape ipcMain.handle takes; route() forwards it unchanged.
type IpcHandler = Parameters<typeof ipcMain.handle>[1]

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

// The shared per-worktree chat channel. Agents post through the grove-chat nib
// extension, which writes the same file this reads.
const channel = new WorktreeChannel({
  onMessage: (message) => send('event:worktree-chat', message)
})

const checkpoints = new CheckpointManager({
  onChange: (all) => {
    send('event:checkpoints', all)
    if (context.repoPath) void updateRepoState(context.repoPath, { checkpoints: all })
  }
})

const watcher = new WorktreeWatcher((change) => {
  send('event:fs-change', change)
  eventHub.publish({ topic: 'files.didChange', payload: change })
  // Any working-tree change can flip git status: advance the generation the
  // git routes hand out as statusVersion.
  gitStatusVersions.bump(change.worktreeId)
  // Stage file writes made while an agent turn is open, so they can be reviewed
  // as a batch. Directory events carry no content to review.
  if (change.type === 'addDir' || change.type === 'unlinkDir') return
  review.noteWrite(change.worktreeId, change.relPath)
})

// Review is watcher-keyed: the watcher says which files changed, and a
// checkpoint taken when the batch opened supplies their pre-batch content.
const review = new ReviewService(
  {
    open: (worktreePath) => checkpoints.baselineTree(worktreePath, { note: 'review baseline' }),
    read: (worktreePath, tree, relPath) => checkpoints.readFromTree(worktreePath, tree, relPath)
  },
  {
    onReview: (batch) => {
      review.track(batch)
      send('event:agent-review', batch)
    },
    onStaged: (worktreeId, count) => send('event:agent-review-staged', { worktreeId, count }),
    // chatId is the nib session; feedback is delivered as a steer message so it
    // lands at the top of the next turn.
    onFeedback: (_worktreeId, _agent, chatId, text) => {
      void nibReviewBridge.sendMessage(chatId, text).catch(() => {})
    }
  },
  {
    pause: () => settings.get<boolean>('workbench.reviewPause') === true,
    postApprove: () => settings.get<string>('workbench.reviewMode') === 'post'
  }
)

const settings = new SettingsService({
  onChange: (snapshot) => send('event:settings-changed', snapshot)
})

// The embedded agent server. Started lazily — the first grove-nib:// request
// brings it up — so a grove that never opens the agent pane never pays for it.
const nib = new NibServer({
  configuredPath: () => settings.get<string>('workbench.nibPath'),
  events: {
    onReady: () => {
      send('event:nib-status', nib.status())
      // A restart invalidates every stream, so the bridge re-subscribes rather
      // than waiting for its next sync.
      nibReviewBridge.reset()
      nibReviewBridge.start()
    },
    onExit: () => {
      send('event:nib-status', nib.status())
      nibReviewBridge.reset()
    }
  }
})

// Watches nib's sessions so a review keeps blocking the agent whether or not the
// agent pane is open.
const nibClient = new NibClient(() => nib.endpoint())

const nibReviewBridge = new NibReviewBridge({
  review,
  endpoint: () => nib.endpoint(),
  worktrees: () => context.worktrees,
  reviewMode: () => settings.get<string>('workbench.reviewMode') ?? 'pre'
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

// Debug harness: arbitrary Lua in the editor and arbitrary JS in the renderer.
// Only registered under GROVE_DEBUG, so a normal build never carries it.
if (process.env.GROVE_DEBUG === '1') {
  registerDebugRoutes(apiRegistry, {
    nvimSessionIds: () => nvims.sessionIds(),
    nvimRequest: (id, method, args) => nvims.request(id, method, args),
    rendererEval: async (expression) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('no renderer window is open')
      return window.webContents.executeJavaScript(expression, true)
    }
  })
  console.warn('[grove] GROVE_DEBUG=1 — debug.* API routes are registered')
}

registerEventRoutes(apiRegistry, { hub: eventHub })
registerEditorRoutes(apiRegistry, {
  documents: editorDocs,
  openInEditor: (worktreeId, path, line) => send('event:api-open-file', { worktreeId, path, line })
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
      (worktreeId, line) =>
        send('event:log', { worktreeId, source: 'service', name: 'setup', line })
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
  listSessions: () => nibClient.listSessions(),
  listModels: () => nibClient.listModels(),
  listEvents: (sessionId, after) => nibClient.listEvents(sessionId, after),
  createSession: (workspace, title) => nibClient.createSession(workspace, title),
  send: (sessionId, text) => nibClient.send(sessionId, text),
  interrupt: (sessionId) => nibClient.interrupt(sessionId),
  unqueue: (sessionId, messageId) => nibClient.unqueue(sessionId, messageId),
  observe: (sessionId, onEvent) => nibClient.observe(sessionId, onEvent),
  sendChatAs: (worktreeId, from, text) => channel.post(worktreeId, from, text),
  chatHistory: (worktreeId, since) => channel.list(worktreeId, since)
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
  info: RepoInfo
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
  const repoState = await getRepoState(root)
  checkpoints.hydrate(repoState.checkpoints || {})
  const list = await refreshWorktrees()
  return {
    info: {
      path: root,
      name: root.split('/').pop() || root,
      currentBranch: await git.currentBranch(root),
      hasAgentsFile: await hasAgentsFile(root),
      hasConfig: await config.configExists(root)
    },
    worktrees: list
  }
}

/**
 * Every IPC channel Grove exposes, mounted as one plugin. Each handler is an
 * effect, so `ipcMain.removeHandler` runs when the plugin unloads instead of a
 * stale handler outliving the subsystem behind it.
 */
const ipcRoutes = {
  name: 'main/ipc',

  apply(ctx: Context): void {
    const route = (channel: string, handler: IpcHandler): void => {
      ctx.effect(() => {
        ipcMain.handle(channel, handler)
        return () => ipcMain.removeHandler(channel)
      }, `ipc:${channel}`)
    }

    // ── Repo ──────────────────────────────────────────────────────
    route('repo:pick', async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (result.canceled || result.filePaths.length === 0) return null
      return openRepo(result.filePaths[0])
    })

    route('repo:open', (_e, repoPath: string) => openRepo(repoPath))

    route('repo:last', async () => {
      const state = await loadState()
      return state.lastRepoPath
    })

    // ── Worktrees ─────────────────────────────────────────────────
    route('worktrees:list', () => refreshWorktrees())

    route(
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

    route('worktrees:remove', async (_e, worktreeId: string, force: boolean) => {
      const { repoPath } = requireRepo()
      const worktree = findWorktree(worktreeId)
      await supervisor.stopAllForWorktree(worktreeId)
      await worktrees.removeWorktree(repoPath, worktree.path, force)
      return refreshWorktrees()
    })

    // ── Git (branches + diff) ─────────────────────────────────────
    route('git:branches', () => {
      const { repoPath } = requireRepo()
      return git.listBranches(repoPath)
    })

    route('git:changedFiles', (_e, worktreeId: string) => {
      const worktree = findWorktree(worktreeId)
      return git.changedFiles(worktree.path)
    })

    route('git:diffSides', (_e, worktreeId: string, file: DiffFile) => {
      const worktree = findWorktree(worktreeId)
      return git.diffSides(worktree.path, file)
    })

    route('git:diffHunks', (_e, worktreeId: string, file: DiffFile) => {
      const worktree = findWorktree(worktreeId)
      return git.diffHunks(worktree.path, file)
    })

    route('git:diffStats', (_e, worktreeId: string) => {
      const worktree = findWorktree(worktreeId)
      return git.diffStats(worktree.path)
    })

    // ── Local-only checkpoints ──────────────────────────────────────
    route('checkpoints:list', (_e, worktreeId: string) => {
      const worktree = findWorktree(worktreeId)
      return checkpoints.list(worktree.path)
    })

    route('checkpoints:snapshot', (_e, worktreeId: string, note?: string) => {
      const worktree = findWorktree(worktreeId)
      return checkpoints.snapshot(worktree.path, 'manual', { note })
    })

    route('checkpoints:restore', (_e, worktreeId: string, commit: string) => {
      const worktree = findWorktree(worktreeId)
      return checkpoints.restore(worktree.path, commit)
    })

    // ── Inline agent edit (per-hunk accept/reject) ──────────────────
    route(
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

    route(
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
    route('git:diffText', (_e, worktreeId: string, before: string, after: string) => {
      const worktree = findWorktree(worktreeId)
      return inlineDiff.diffStrings(worktree.path, before, after)
    })

    // ── Git ship-it chain (stage → commit → push → merge → archive) ──
    route('git:stage', (_e, worktreeId: string, paths: string[]) => {
      const worktree = findWorktree(worktreeId)
      return git.stage(worktree.path, paths)
    })

    route('git:unstage', (_e, worktreeId: string, paths: string[]) => {
      const worktree = findWorktree(worktreeId)
      return git.unstage(worktree.path, paths)
    })

    route('git:commit', (_e, worktreeId: string, message: string) => {
      const worktree = findWorktree(worktreeId)
      return git.commit(worktree.path, message)
    })

    route('git:push', (_e, worktreeId: string) => {
      const worktree = findWorktree(worktreeId)
      return git.push(worktree.path)
    })

    // Local merge runs in the main worktree (repoPath), merging the feature
    // worktree's branch into baseBranch.
    route('git:mergeLocal', (_e, worktreeId: string, baseBranch: string) => {
      const { repoPath } = requireRepo()
      const worktree = findWorktree(worktreeId)
      return git.mergeToBase(repoPath, worktree.branch, baseBranch)
    })

    // ── Worktree-into-worktree merge ────────────────────────────────
    route('git:mergePreview', async (_e, targetWorktreeId: string, sourceWorktreeId: string) => {
      const target = findWorktree(targetWorktreeId)
      const source = findWorktree(sourceWorktreeId)
      const preview = await git.mergePreview(target.path, source.branch)
      return { ...preview, sourceDirty: await git.isDirty(source.path) }
    })

    route(
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

    route('git:mergeAbort', (_e, targetWorktreeId: string) => {
      const target = findWorktree(targetWorktreeId)
      return git.abortMerge(target.path)
    })

    route('git:mergeContinue', (_e, targetWorktreeId: string) => {
      const target = findWorktree(targetWorktreeId)
      return git.continueMerge(target.path)
    })

    route('git:mergeConflicts', (_e, targetWorktreeId: string) => {
      const target = findWorktree(targetWorktreeId)
      return git.conflictedFiles(target.path)
    })

    route('github:openPr', (_e, worktreeId: string, options: OpenPrOptions) => {
      const worktree = findWorktree(worktreeId)
      return github.openPr(worktree.path, options)
    })

    route('github:mergePr', (_e, worktreeId: string, options: MergePrOptions) => {
      const worktree = findWorktree(worktreeId)
      return github.mergePr(worktree.path, options)
    })

    route(
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
    route('config:load', async () => {
      const { repoPath } = requireRepo()
      context.config = await config.loadConfig(repoPath)
      return context.config
    })

    route('config:exists', () => {
      const { repoPath } = requireRepo()
      return config.configExists(repoPath)
    })

    route('config:writeSample', async () => {
      const { repoPath } = requireRepo()
      const written = await config.writeSampleConfig(repoPath)
      context.config = await config.loadConfig(repoPath)
      return written
    })

    // Setup wizard: propose service entries from what the repo looks like.
    route('config:detect', () => {
      const { repoPath } = requireRepo()
      return detectServices(repoPath)
    })

    // Setup wizard: write the reviewed services into workbench.yaml, merged over
    // whatever is already there so a partially configured repo is not clobbered.
    route('config:writeServices', async (_e, services: Record<string, ServiceConfig>) => {
      const { repoPath } = requireRepo()
      const current = await config.loadConfig(repoPath)
      const merged: WorkbenchConfig = {
        ...current,
        services: { ...current.services, ...services }
      }
      await config.saveConfig(repoPath, merged)
      context.config = await config.loadConfig(repoPath)
      return context.config
    })

    // ── Services ──────────────────────────────────────────────────
    route('services:list', (_e, worktreeId: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return Object.entries(cfg.services).map(([name, service]) => {
        const live = supervisor.getRuntime(worktreeId, name)
        return live || supervisor.buildIdleRuntime(worktree, name, service, ports)
      })
    })

    route('services:start', (_e, worktreeId: string, name: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const service = cfg.services[name]
      if (!service) throw new Error(`unknown service: ${name}`)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return supervisor.start(worktree, name, service, ports)
    })

    route('services:startAll', async (_e, worktreeId: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      for (const [name, service] of Object.entries(cfg.services)) {
        await supervisor.start(worktree, name, service, ports)
      }
    })

    route('services:stop', (_e, worktreeId: string, name: string) =>
      supervisor.stop(worktreeId, name)
    )

    route('services:stopAll', (_e, worktreeId: string) => supervisor.stopAllForWorktree(worktreeId))

    route('services:restart', (_e, worktreeId: string, name: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const service = cfg.services[name]
      if (!service) throw new Error(`unknown service: ${name}`)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      return supervisor.start(worktree, name, service, ports)
    })

    // ── Agent review ──────────────────────────────────────────────
    // Sessions, transcripts and approvals live on the nib server and are driven
    // from the renderer over grove-nib://. What stays here is the review flow,
    // which writes files and therefore cannot.
    route('agents:discardReview', (_e, batchId: string) => {
      nibReviewBridge.discard(batchId)
      review.drop(batchId)
    })

    route('agents:resolveReview', async (_e, batchId: string, decisions: HunkDecision[]) => {
      const batch = await review.resolve(batchId, decisions)
      if (!batch) return
      // A nib session is answered over its own protocol, not the adapter's
      // permission resolver.
      if (batch.agent === NIB_AGENT) {
        await nibReviewBridge.report(batch, decisions)
        return
      }
    })

    // ── Shared worktree chat (agent↔agent + agent↔user) ─────────────
    route('chat:send', (_e, worktreeId: string, text: string) => {
      findWorktree(worktreeId)
      return channel.post(worktreeId, { kind: 'user', name: 'you' }, text)
    })

    route('chat:history', async (_e, worktreeId: string, since?: number) => {
      findWorktree(worktreeId)
      // Watching is started lazily: a worktree whose channel nobody has opened
      // does not need a file watcher.
      await channel.watchWorktree(worktreeId)
      return channel.list(worktreeId, since)
    })

    // ── Files ─────────────────────────────────────────────────────
    route('files:listDir', (_e, worktreeId: string, relPath: string) => {
      const worktree = findWorktree(worktreeId)
      return files.listDir(worktree.path, relPath)
    })

    route('files:listAll', (_e, worktreeId: string) => {
      const worktree = findWorktree(worktreeId)
      return files.listAll(worktree.path)
    })

    // Arbitrary-directory listing for @ path completion (may leave the worktree).
    route('files:listPath', (_e, worktreeId: string, rawPath: string) => {
      const worktree = findWorktree(worktreeId)
      return files.listPath(worktree.path, rawPath)
    })

    route('files:read', (_e, worktreeId: string, absPath: string) => {
      const worktree = findWorktree(worktreeId)
      return files.readFileContent(worktree.path, absPath)
    })

    route('files:write', (_e, worktreeId: string, absPath: string, content: string) => {
      const worktree = findWorktree(worktreeId)
      return files.writeFileContent(worktree.path, absPath, content)
    })

    // Save a pasted/dropped attachment for @-mentioning in the agent prompt.
    route('files:saveAttachment', (_e, worktreeId: string, data: Uint8Array, ext: string) => {
      const worktree = findWorktree(worktreeId)
      return files.saveAttachment(worktree.path, data, ext)
    })

    route('files:create', (_e, worktreeId: string, relPath: string) => {
      const worktree = findWorktree(worktreeId)
      return files.createFile(worktree.path, relPath)
    })

    route('files:createDir', (_e, worktreeId: string, relPath: string) => {
      const worktree = findWorktree(worktreeId)
      return files.createDir(worktree.path, relPath)
    })

    route('files:rename', (_e, worktreeId: string, fromRel: string, toRel: string) => {
      const worktree = findWorktree(worktreeId)
      return files.renamePath(worktree.path, fromRel, toRel)
    })

    route('files:delete', (_e, worktreeId: string, relPath: string) => {
      const worktree = findWorktree(worktreeId)
      return files.removePath(worktree.path, relPath)
    })

    // ── Editor catalog (grammars / themes / LSP servers) ──────────
    route('extensions:catalog', () => editorCatalog.listCatalog())
    route('extensions:installed', () => editorCatalog.listInstalled())
    route('extensions:install', (_e, id: string) => editorCatalog.install(id))
    route('extensions:uninstall', (_e, id: string) => editorCatalog.uninstall(id))
    route('extensions:setEnabled', (_e, id: string, enabled: boolean) =>
      editorCatalog.setEnabled(id, enabled)
    )
    route('extensions:grammar', (_e, id: string) => editorCatalog.readGrammar(id))

    // ── LSP ───────────────────────────────────────────────────────
    route('lsp:ensure', (_e, worktreeId: string, language: string, uri: string, text: string) => {
      const worktree = findWorktree(worktreeId)
      return lsp.ensure(worktreeId, worktree.path, language, uri, text)
    })
    route(
      'lsp:didChange',
      (_e, worktreeId: string, language: string, uri: string, version: number, text: string) =>
        lsp.didChange(worktreeId, language, uri, version, text)
    )
    route(
      'lsp:completion',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        lsp.completion(worktreeId, language, uri, position)
    )
    route(
      'lsp:hover',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        lsp.hover(worktreeId, language, uri, position)
    )
    route(
      'lsp:definition',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        lsp.definition(worktreeId, language, uri, position)
    )
    route(
      'lsp:references',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        lsp.references(worktreeId, language, uri, position)
    )
    route(
      'lsp:implementation',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        lsp.implementation(worktreeId, language, uri, position)
    )
    route(
      'lsp:typeDefinition',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        lsp.typeDefinition(worktreeId, language, uri, position)
    )
    route(
      'lsp:declaration',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        lsp.declaration(worktreeId, language, uri, position)
    )
    route(
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
    route(
      'lsp:formatting',
      (_e, worktreeId: string, language: string, uri: string, tabSize: number) =>
        lsp.formatting(worktreeId, language, uri, tabSize)
    )
    route(
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
    route('lsp:resolveCodeAction', (_e, worktreeId: string, language: string, action: CodeAction) =>
      lsp.resolveCodeAction(worktreeId, language, action)
    )
    route(
      'lsp:executeCommand',
      (_e, worktreeId: string, language: string, command: string, args: unknown[]) =>
        lsp.executeCommand(worktreeId, language, command, args)
    )
    route(
      'lsp:inlayHints',
      (_e, worktreeId: string, language: string, uri: string, range: LspRange) =>
        lsp.inlayHints(worktreeId, language, uri, range)
    )

    // ── Terminal ──────────────────────────────────────────────────
    // Spawn a shell in the worktree's directory with its WT_*/PORT_n vars, so a
    // terminal matches what services and keybind actions see.
    route('terminal:create', (_e, worktreeId: string | null, cols: number, rows: number) => {
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
    route('terminal:write', (_e, id: string, data: string) => terminals.write(id, data))
    route('terminal:resize', (_e, id: string, cols: number, rows: number) =>
      terminals.resize(id, cols, rows)
    )
    route('terminal:kill', (_e, id: string) => terminals.kill(id))

    // ── Embedded Neovim ───────────────────────────────────────────
    // A vendored `nvim --embed` per pane, spawned in the worktree with the same
    // WT_*/PORT_n vars as terminals. Redraw batches stream via event:nvim-redraw.
    route('nvim:spawn', async (_e, worktreeId: string | null) => {
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
    route('nvim:attach', (_e, id: string, cols: number, rows: number, file?: string) =>
      nvims.attach(id, cols, rows, file)
    )
    route('nvim:input', (_e, id: string, keys: string) => {
      trackNvimActivity(id)
      nvims.input(id, keys)
    })
    route(
      'nvim:inputMouse',
      (
        _e,
        id: string,
        button: string,
        action: string,
        modifier: string,
        row: number,
        col: number,
        grid?: number
      ) => {
        trackNvimActivity(id)
        nvims.inputMouse(id, button, action, modifier, row, col, grid)
      }
    )
    route('nvim:resize', (_e, id: string, cols: number, rows: number) =>
      nvims.resize(id, cols, rows)
    )
    route('nvim:command', (_e, id: string, command: string) => nvims.command(id, command))
    route('nvim:request', (_e, id: string, method: string, args: unknown[]) =>
      nvims.request(id, method, args)
    )
    route('nvim:kill', (_e, id: string) => nvims.kill(id))

    // ── State ─────────────────────────────────────────────────────
    route('state:getRepo', () => {
      const { repoPath } = requireRepo()
      return getRepoState(repoPath)
    })

    route('state:update', (_e, patch: Record<string, unknown>) => {
      const { repoPath } = requireRepo()
      return updateRepoState(repoPath, patch)
    })

    // ── File watching ─────────────────────────────────────────────
    // Watch exactly the given worktrees (selected + those with running agents).
    route('fs:watch', (_e, worktreeIds: string[]) => {
      const paths = worktreeIds
        .map((id) => context.worktrees.find((worktree) => worktree.id === id)?.path)
        .filter((path): path is string => Boolean(path))
      watcher.setWatched(paths)
    })

    // ── Agent server ──────────────────────────────────────────────
    registerNibProtocol(nib)
    route('nib:status', () => nib.status())
    route('nib:start', async () => {
      await nib.start()
      return nib.status()
    })

    // ── Plugins ───────────────────────────────────────────────────
    registerPluginProtocol(pluginRegistry)
    void pluginRegistry.loadAll(null)
    route('plugins:list', () => pluginList())
    route('plugins:trust', async (_e: IpcMainInvokeEvent, pluginId: string) => {
      const record = pluginRegistry.get(pluginId)
      if (!record || !context.repoPath) return pluginList()
      await pluginBroker.trustProjectPlugin(context.repoPath, record.manifest)
      await pluginRegistry.refresh(pluginId)
      send('event:plugins-changed', pluginList())
      return pluginList()
    })
    route(
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
    route(
      'plugins:invoke',
      (
        _e: IpcMainInvokeEvent,
        pluginId: string,
        callId: string,
        method: string,
        params: unknown
      ) => {
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
            send('event:plugin-stream', {
              pluginId,
              callId,
              end: true,
              error: { message: error.message }
            })
          )
        return null
      }
    )
    route('plugins:cancel', (_e: IpcMainInvokeEvent, pluginId: string, callId: string) =>
      apiDispatcher.cancel(`plugin:${pluginId}`, callId)
    )
    route('plugins:cancelAll', (_e: IpcMainInvokeEvent, pluginId: string) => {
      aiBridge.clearPlugin(pluginId)
      apiDispatcher.cancelAllForClient(`plugin:${pluginId}`)
    })
    route(
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
    route('plugins:grants:list', async () => pluginBroker.listGrants(await grantClients()))
    route(
      'plugins:grants:revoke',
      async (_e: IpcMainInvokeEvent, clientId: string, permission: PluginPermission) => {
        await pluginBroker.revoke(clientId, permission)
        return pluginBroker.listGrants(await grantClients())
      }
    )
    route(
      'plugins:grants:revokeScope',
      async (_e: IpcMainInvokeEvent, clientId: string, path: string) => {
        await pluginBroker.revokeFsScope(clientId, path)
        return pluginBroker.listGrants(await grantClients())
      }
    )
    route('plugins:grants:revokeAll', async (_e: IpcMainInvokeEvent, clientId: string) => {
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
    route('apps:list', () => appPairing.list())
    route('apps:respondPairing', (_e: IpcMainInvokeEvent, id: string, approved: boolean) =>
      appPairing.respondPairing(id, approved)
    )
    route('apps:revoke', async (_e: IpcMainInvokeEvent, appId: string) => {
      await appPairing.revoke(appId)
      await pluginBroker.revokeAll(`app:${appId}`)
      apiSocketServer?.dropClient(`app:${appId}`)
      return appPairing.list()
    })
    route(
      'plugins:respondToolCall',
      (_e: IpcMainInvokeEvent, id: string, result: unknown, errorMessage?: string) =>
        aiBridge.respondToolCall(id, result, errorMessage)
    )

    // ── Keybind actions ───────────────────────────────────────────
    route('actions:runShell', (_e: IpcMainInvokeEvent, worktreeId: string, commandLine: string) => {
      const { config: cfg } = requireRepo()
      const worktree = findWorktree(worktreeId)
      const ports = worktrees.portsForWorktree(cfg, worktree.portSlot)
      actionRunner.run(worktree, commandLine, ports)
    })

    // ── Settings ──────────────────────────────────────────────────
    void settings.loadUser()
    route('settings:read', () => settings.snapshot())
    route(
      'settings:set',
      async (_e: IpcMainInvokeEvent, key: string, value: unknown, scope: SettingScope) => {
        const snapshot = await settings.set(key, value, scope)
        // Broadcast so every window (and future ones) stays coherent.
        send('event:settings-changed', snapshot)
        return snapshot
      }
    )
    route('settings:openFile', (_e: IpcMainInvokeEvent, scope: SettingScope) => {
      const path = settings.openPath(scope)
      if (!path) return
      return shell.openPath(path)
    })

    // ── Misc ──────────────────────────────────────────────────────
    route('shell:openExternal', (_e: IpcMainInvokeEvent, url: string) => shell.openExternal(url))
  }
}

/** Mount the IPC routes on the main kernel. */
export async function registerIpc(): Promise<void> {
  await mainContext.plugin(ipcRoutes)
}

/**
 * Kill every embedded-Neovim sidecar. Called when the renderer is about to be
 * replaced (reload, dev hot restart, crash recovery): those processes are driven
 * entirely from the renderer, so a document that goes away leaves them
 * unreachable — still running, still holding their buffers, and still pushing
 * diagnostics that no pane can correct. The fresh renderer respawns whatever its
 * panes need.
 */
export function reapNvimSessions(): void {
  const orphaned = nvims.sessionIds()
  if (orphaned.length === 0) return
  console.warn(`[nvim] renderer replaced; reaping ${orphaned.length} orphaned session(s)`)
  nvims.killAll()
}

// Clean shutdown: drop the IPC surface, then kill every child process.
export async function shutdown(): Promise<void> {
  await mainContext.fiber.dispose().catch(() => {})
  await apiSocketServer?.close().catch(() => {})
  nibReviewBridge.stop()
  await nib.stop().catch(() => {})
  await supervisor.stopAll()
  await watcher.closeAll()
  channel.closeAll()
  lsp.stopAll()
  terminals.killAll()
  nvims.killAll()
  settings.close()
  actionRunner.stopAll()
}
