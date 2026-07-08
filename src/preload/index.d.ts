import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Location,
  WorkspaceEdit,
  TextEdit,
  CodeAction,
  Command
} from 'vscode-languageserver-types'
import type {
  Worktree,
  BranchList,
  DiffFile,
  DiffSides,
  WorkbenchConfig,
  ServiceRuntime,
  AgentRuntime,
  AgentConfig,
  AgentLaunchOptions,
  AgentDialogDecision,
  AgentChats,
  ChatMeta,
  PermissionDecision,
  FileNode,
  RepoInfo,
  CatalogEntry,
  InstalledExtension,
  GrammarPayload,
  LspPosition,
  LspCompletion,
  LspRange,
  LspDiagnostic
} from '../shared/types'

interface OpenRepoResult {
  info: RepoInfo
  worktrees: Worktree[]
}

interface RepoStateShape {
  portSlots: Record<string, number>
  openTabs: string[]
  activeTabPath: string | null
  selectedWorktreeId: string | null
  setupOnceDone: boolean
  agentSessions: Record<string, string>
  trustedActionHashes: string[]
  viewLayouts: Record<string, unknown>
  activeLayoutView: string | null
  paneSizes: Record<string, number>
  panelsOpen: Record<string, boolean>
  centerView: string | null
  activeView: string | null
}

interface SettingsSnapshotShape {
  user: Record<string, unknown>
  project: Record<string, unknown>
}

interface PluginRecordShape {
  id: string
  manifest: import('../shared/plugins').PluginManifest
  source: 'builtin' | 'user' | 'project'
  status: 'ready' | 'disabled' | 'blocked' | 'invalid'
  errors: string[]
}

export interface WorkbenchApi {
  repo: {
    pick: () => Promise<OpenRepoResult | null>
    open: (repoPath: string) => Promise<OpenRepoResult>
    last: () => Promise<string | null>
  }
  worktrees: {
    list: () => Promise<Worktree[]>
    create: (options: { name: string; baseBranch: string; newBranch?: string }) => Promise<Worktree>
    remove: (worktreeId: string, force: boolean) => Promise<Worktree[]>
  }
  git: {
    branches: () => Promise<BranchList>
    changedFiles: (worktreeId: string) => Promise<DiffFile[]>
    diffSides: (worktreeId: string, file: DiffFile) => Promise<DiffSides>
  }
  config: {
    load: () => Promise<WorkbenchConfig>
    exists: () => Promise<boolean>
    writeSample: () => Promise<boolean>
  }
  services: {
    list: (worktreeId: string) => Promise<ServiceRuntime[]>
    start: (worktreeId: string, name: string) => Promise<ServiceRuntime>
    startAll: (worktreeId: string) => Promise<void>
    stop: (worktreeId: string, name: string) => Promise<void>
    stopAll: (worktreeId: string) => Promise<void>
    restart: (worktreeId: string, name: string) => Promise<ServiceRuntime>
  }
  agents: {
    list: (worktreeId: string) => Promise<AgentRuntime[]>
    configs: () => Promise<Record<string, AgentConfig>>
    start: (worktreeId: string, name: string, options: AgentLaunchOptions) => Promise<AgentRuntime>
    stop: (worktreeId: string, name: string) => Promise<void>
    compact: (worktreeId: string, name: string, instructions?: string) => Promise<AgentRuntime>
    reset: (worktreeId: string, name: string) => Promise<ChatMeta>
    transcript: (worktreeId: string, name: string) => Promise<string[]>
    chats: (worktreeId: string, name: string) => Promise<AgentChats>
    renameChat: (
      worktreeId: string,
      name: string,
      chatId: string,
      chatName: string
    ) => Promise<void>
    activateChat: (worktreeId: string, name: string, chatId: string) => Promise<string[]>
    respondPermission: (id: string, decision: PermissionDecision) => Promise<void>
    respondDialog: (id: string, decision: AgentDialogDecision) => Promise<void>
    active: () => Promise<string[]>
  }
  fs: {
    watch: (worktreeIds: string[]) => Promise<void>
  }
  files: {
    listDir: (worktreeId: string, relPath: string) => Promise<FileNode[]>
    listAll: (worktreeId: string) => Promise<string[]>
    read: (worktreeId: string, absPath: string) => Promise<string>
    write: (worktreeId: string, absPath: string, content: string) => Promise<void>
    create: (worktreeId: string, relPath: string) => Promise<string>
    createDir: (worktreeId: string, relPath: string) => Promise<string>
    rename: (worktreeId: string, fromRel: string, toRel: string) => Promise<string>
    delete: (worktreeId: string, relPath: string) => Promise<void>
  }
  extensions: {
    catalog: () => Promise<CatalogEntry[]>
    installed: () => Promise<InstalledExtension[]>
    install: (id: string) => Promise<InstalledExtension>
    uninstall: (id: string) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    grammar: (id: string) => Promise<GrammarPayload | null>
  }
  lsp: {
    ensure: (worktreeId: string, language: string, uri: string, text: string) => Promise<boolean>
    didChange: (
      worktreeId: string,
      language: string,
      uri: string,
      version: number,
      text: string
    ) => Promise<void>
    completion: (
      worktreeId: string,
      language: string,
      uri: string,
      position: LspPosition
    ) => Promise<LspCompletion[]>
    hover: (
      worktreeId: string,
      language: string,
      uri: string,
      position: LspPosition
    ) => Promise<string | null>
    definition: (
      worktreeId: string,
      language: string,
      uri: string,
      position: LspPosition
    ) => Promise<Location[]>
    references: (
      worktreeId: string,
      language: string,
      uri: string,
      position: LspPosition
    ) => Promise<Location[]>
    implementation: (
      worktreeId: string,
      language: string,
      uri: string,
      position: LspPosition
    ) => Promise<Location[]>
    typeDefinition: (
      worktreeId: string,
      language: string,
      uri: string,
      position: LspPosition
    ) => Promise<Location[]>
    declaration: (
      worktreeId: string,
      language: string,
      uri: string,
      position: LspPosition
    ) => Promise<Location[]>
    rename: (
      worktreeId: string,
      language: string,
      uri: string,
      position: LspPosition,
      newName: string
    ) => Promise<WorkspaceEdit | null>
    formatting: (
      worktreeId: string,
      language: string,
      uri: string,
      tabSize: number
    ) => Promise<TextEdit[]>
    codeAction: (
      worktreeId: string,
      language: string,
      uri: string,
      range: LspRange,
      diagnostics: LspDiagnostic[]
    ) => Promise<(Command | CodeAction)[]>
    resolveCodeAction: (
      worktreeId: string,
      language: string,
      action: CodeAction
    ) => Promise<CodeAction>
    executeCommand: (
      worktreeId: string,
      language: string,
      command: string,
      args: unknown[]
    ) => Promise<void>
  }
  state: {
    getRepo: () => Promise<RepoStateShape>
    update: (patch: Partial<RepoStateShape>) => Promise<RepoStateShape>
  }
  actions: {
    runShell: (worktreeId: string, commandLine: string) => Promise<void>
  }
  plugins: {
    list: () => Promise<PluginRecordShape[]>
    trust: (pluginId: string) => Promise<PluginRecordShape[]>
    setEnabled: (pluginId: string, enabled: boolean) => Promise<PluginRecordShape[]>
    invoke: (pluginId: string, callId: string, method: string, params: unknown) => Promise<unknown>
    cancel: (pluginId: string, callId: string) => Promise<void>
    cancelAll: (pluginId: string) => Promise<void>
    respondPermission: (id: string, decision: string) => Promise<void>
    respondToolCall: (id: string, result: unknown, errorMessage?: string) => Promise<void>
  }
  settings: {
    read: () => Promise<SettingsSnapshotShape>
    set: (key: string, value: unknown, scope: 'user' | 'project') => Promise<SettingsSnapshotShape>
    openFile: (scope: 'user' | 'project') => Promise<string | void>
  }
  openExternal: (url: string) => Promise<void>
  on: (channel: string, callback: (payload: unknown) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    workbench: WorkbenchApi
  }
}
