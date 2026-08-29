// Central IPC surface. Registers every ipcMain.handle channel and pushes
// streamed events (logs, service/agent status) to the renderer. This is the
// single source of truth for the API exposed via preload.

import { app, dialog, BrowserWindow } from 'electron'
import { access } from 'fs/promises'
import { join } from 'path'
import type { Context } from '@neoworks/extension-system'
import { mainContext } from './kernel/context'
import { routePlugins } from './routes'
import type { WorkbenchService, NvimService, PluginsService, AppsService } from './kernel/services'
import type { WorkbenchConfig, Worktree, RepoInfo } from '../shared/types'
import * as git from './git'
import { CheckpointManager } from './checkpoints'
import * as config from './config'
import { LspManager } from './lsp'
import * as worktrees from './worktrees'
import { ServiceSupervisor } from './services'
import { WorktreeWatcher } from './watcher'
import { WorktreeChannel } from './worktreeChannel'
import { ReviewService } from './review'
import { getRepoState, updateRepoState, setLastRepo } from './state'
import { SettingsService } from './settings'
import { ActionRunner } from './actions'
import { TerminalManager } from './terminals'
import { NeovimManager } from './nvim'
import { buildWorktreeEnv, spawnEnv } from './env'
import { PermissionBroker, PermissionError } from './api/broker'
import { clientFromPlugin, type ClientRecord } from './api/clients'
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
import { HarnessRegistry } from './agents/harness'
import { SessionStore } from './agents/store'
import { AgentService } from './agents/service'
import { AgentReviewBridge } from './agents/reviewBridge'
import { groveTools } from './agents/tools'

interface RepoContext {
  repoPath: string | null
  config: WorkbenchConfig | null
  worktrees: Worktree[]
}

const context: RepoContext = { repoPath: null, config: null, worktrees: [] }

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

// The shared per-worktree chat channel. Agents post through grove's own chat
// tools, which append to the same file this reads.
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
    // chatId is the agent session; feedback is delivered as a steer message so
    // it lands at the top of the next turn.
    onFeedback: (_worktreeId, _agent, chatId, text) => {
      void agentReviewBridge.sendMessage(chatId, text).catch(() => {})
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

// Agent sessions. The harnesses themselves are mounted as plugins, so the only
// thing constructed here is the state they share: the registry they register
// into, the store that persists sessions, and the service that drives them.
const harnesses = new HarnessRegistry()

const sessionStore = new SessionStore(join(app.getPath('userData'), 'agents'), (message) =>
  console.error(`[agents] ${message}`)
)

const agents = new AgentService({
  store: sessionStore,
  harnesses,
  tools: () => groveTools({ chat: channel }),
  publish: (event) => send('event:agent-event', event),
  defaultHarness: () => settings.get<string>('workbench.agentHarness')
})

// Watches the event log so a review keeps blocking the agent whether or not the
// agent pane is open.
const agentReviewBridge = new AgentReviewBridge({
  review,
  agents,
  store: sessionStore,
  harnesses,
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
  listSessions: () => agents.listSessions(),
  listModels: () => agents.allModels(),
  listEvents: (sessionId, after) => agents.listEvents(sessionId, after),
  createSession: (workspace, title) => agents.createSession({ workspace, title }),
  send: (sessionId, text) =>
    agents
      .send(sessionId, [{ type: 'user.message', content: [{ type: 'text', text }] }])
      .then(() => undefined),
  interrupt: (sessionId) =>
    agents.send(sessionId, [{ type: 'user.interrupt' }]).then(() => undefined),
  unqueue: (sessionId, messageId) =>
    agents.send(sessionId, [{ type: 'user.unqueue', messageId }]).then(() => undefined),
  observe: (sessionId, onEvent) => agents.observe(sessionId, onEvent),
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

// The subsystems above, published as kernel services. Route plugins inject
// these instead of importing this module, so each domain of the IPC surface can
// live in its own file and state stays owned by one place.
const mainServices = {
  name: 'main/services',

  apply(ctx: Context): void {
    ctx.provide('workbench', {
      send,
      requireRepo,
      findWorktree,
      refreshWorktrees,
      openRepo,
      reloadConfig: async () => {
        const { repoPath } = requireRepo()
        context.config = await config.loadConfig(repoPath)
        return context.config
      },
      get repoPath() {
        return context.repoPath
      },
      get worktrees() {
        return context.worktrees
      }
    } satisfies WorkbenchService)

    ctx.provide('nvim', {
      manager: nvims,
      bind: (sessionId, worktreeId) => {
        nvimSessionWorktrees.set(sessionId, worktreeId)
        if (worktreeId && !lastActiveNvimByWorktree.has(worktreeId)) {
          lastActiveNvimByWorktree.set(worktreeId, sessionId)
        }
      },
      trackActivity: trackNvimActivity
    } satisfies NvimService)

    ctx.provide('plugins', {
      registry: pluginRegistry,
      broker: pluginBroker,
      aiBridge,
      dispatcher: apiDispatcher,
      apiRoutes: apiRegistry,
      list: pluginList,
      client: pluginClient,
      grantClients
    } satisfies PluginsService)

    ctx.provide('apps', {
      pairing: appPairing,
      socketPath: () => apiSocketPath,
      dropClient: (clientId) => apiSocketServer?.dropClient(clientId)
    } satisfies AppsService)

    ctx.provide('supervisor', supervisor)
    ctx.provide('checkpoints', checkpoints)
    ctx.provide('review', review)
    ctx.provide('settings', settings)
    ctx.provide('terminals', terminals)
    ctx.provide('lsp', lsp)
    ctx.provide('watcher', watcher)
    ctx.provide('chat', channel)
    ctx.provide('actions', actionRunner)
    ctx.provide('harnesses', harnesses)
    ctx.provide('agents', agents)
    ctx.provide('agentReview', agentReviewBridge)

    // The review bridge follows the log for the life of the process: a gated
    // write blocks the agent whether or not any pane is watching.
    ctx.effect(() => agentReviewBridge.watch(), 'agents:review-bridge')

    // One-time startup work that belongs to no single route domain: the local
    // API socket external apps connect over, and the user settings file.
    startApiSocket()
    void settings.loadUser()
  }
}

/** Every client that can hold a grant: plugins and paired external apps. */
async function grantClients(): Promise<ClientRecord[]> {
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

/**
 * Mount the main kernel: the subsystem services first, then every route plugin.
 * Each route plugin injects what it needs, so ordering beyond this is the
 * kernel's problem, not ours.
 */
export async function registerIpc(): Promise<void> {
  await mainContext.plugin(mainServices)
  await Promise.all(routePlugins.map((plugin) => mainContext.plugin(plugin)))
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
  await agents.stopAll().catch(() => {})
  await sessionStore.flush().catch(() => {})
  await supervisor.stopAll()
  await watcher.closeAll()
  channel.closeAll()
  lsp.stopAll()
  terminals.killAll()
  nvims.killAll()
  settings.close()
  actionRunner.stopAll()
}
