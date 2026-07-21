import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Location,
  WorkspaceEdit,
  TextEdit,
  CodeAction,
  Command,
  InlayHint
} from 'vscode-languageserver-types'
import type {
  Worktree,
  BranchList,
  DiffFile,
  DiffSides,
  DiffHunks,
  DiffStats,
  CheckpointMeta,
  MergeMode,
  MergePreview,
  MergeResult,
  WorktreeChatMessage,
  InlineHunk,
  AppliedRange,
  OpenPrOptions,
  MergePrOptions,
  ArchiveOptions,
  DockLayoutState,
  WorkbenchConfig,
  ServiceRuntime,
  AgentRuntime,
  AgentConfig,
  AgentOption,
  AgentLaunchOptions,
  AgentDialogDecision,
  AgentChats,
  AgentSendResult,
  AgentSlashCommand,
  QueuedMessage,
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
  openTabsByWorktree: Record<string, string[]>
  activeTabByWorktree: Record<string, string | null>
  selectedWorktreeId: string | null
  setupOnceDone: boolean
  introDismissed: boolean
  agentSessions: Record<string, string>
  trustedActionHashes: string[]
  viewLayouts: Record<string, unknown>
  activeLayoutView: string | null
  paneSizes: Record<string, number>
  paneFontScale: Record<string, number>
  panelsOpen: Record<string, boolean>
  centerView: string | null
  activeView: string | null
  docks: DockLayoutState | null
  focusMode: boolean
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

interface ExternalAppShape {
  appId: string
  name: string
  grantedScopes: import('../shared/plugins').PluginPermission[]
  createdAt: string
  lastSeenAt: string
}

interface GrantSummaryShape {
  clientId: string
  clientName: string
  kind: 'plugin' | 'app'
  source?: string
  declared: import('../shared/plugins').PluginPermission[]
  permissions: Partial<
    Record<import('../shared/plugins').PluginPermission, 'granted' | 'denied'>
  >
  fsScopes: string[]
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
    archive: (worktreeId: string, options: ArchiveOptions) => Promise<Worktree[]>
  }
  git: {
    branches: () => Promise<BranchList>
    changedFiles: (worktreeId: string) => Promise<DiffFile[]>
    diffSides: (worktreeId: string, file: DiffFile) => Promise<DiffSides>
    diffHunks: (worktreeId: string, file: DiffFile) => Promise<DiffHunks>
    diffStats: (worktreeId: string) => Promise<DiffStats>
    beginInlineReview: (
      worktreeId: string,
      relPath: string,
      snapshot: string
    ) => Promise<{ hunks: InlineHunk[]; ranges: AppliedRange[] }>
    applyInlineReview: (
      worktreeId: string,
      relPath: string,
      snapshot: string,
      hunks: InlineHunk[],
      applied: boolean[]
    ) => Promise<AppliedRange[]>
    diffText: (worktreeId: string, before: string, after: string) => Promise<string>
    stage: (worktreeId: string, paths: string[]) => Promise<void>
    unstage: (worktreeId: string, paths: string[]) => Promise<void>
    commit: (worktreeId: string, message: string) => Promise<string>
    push: (worktreeId: string) => Promise<string>
    mergeLocal: (worktreeId: string, baseBranch: string) => Promise<string>
    mergePreview: (targetWorktreeId: string, sourceWorktreeId: string) => Promise<MergePreview>
    mergeWorktree: (
      targetWorktreeId: string,
      sourceWorktreeId: string,
      opts: { mode: MergeMode; message?: string }
    ) => Promise<MergeResult>
    mergeAbort: (targetWorktreeId: string) => Promise<void>
    mergeContinue: (targetWorktreeId: string) => Promise<MergeResult>
    mergeConflicts: (targetWorktreeId: string) => Promise<string[]>
  }
  github: {
    openPr: (worktreeId: string, options: OpenPrOptions) => Promise<string>
    mergePr: (worktreeId: string, options: MergePrOptions) => Promise<string>
  }
  checkpoints: {
    list: (worktreeId: string) => Promise<CheckpointMeta[]>
    snapshot: (worktreeId: string, note?: string) => Promise<CheckpointMeta | null>
    restore: (
      worktreeId: string,
      commit: string
    ) => Promise<{ restoredTree: string; preRestore: CheckpointMeta | null }>
  }
  chat: {
    send: (worktreeId: string, text: string) => Promise<WorktreeChatMessage>
    history: (worktreeId: string, since?: number) => Promise<WorktreeChatMessage[]>
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
    models: (name: string) => Promise<AgentOption[]>
    createInstance: (worktreeId: string, name: string, label?: string) => Promise<ChatMeta>
    convertInstance: (
      worktreeId: string,
      fromName: string,
      toName: string,
      chatId: string
    ) => Promise<ChatMeta | null>
    deleteChat: (worktreeId: string, name: string, chatId: string) => Promise<void>
    start: (
      worktreeId: string,
      name: string,
      options: AgentLaunchOptions,
      chatId?: string
    ) => Promise<AgentRuntime>
    stop: (worktreeId: string, name: string, chatId: string) => Promise<void>
    compact: (
      worktreeId: string,
      name: string,
      instructions?: string,
      chatId?: string
    ) => Promise<AgentRuntime>
    reset: (worktreeId: string, name: string, chatId?: string) => Promise<ChatMeta>
    transcript: (worktreeId: string, name: string, chatId?: string) => Promise<string[]>
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
    send: (
      worktreeId: string,
      name: string,
      text: string,
      chatId?: string
    ) => Promise<AgentSendResult>
    queue: (worktreeId: string, name: string, chatId: string) => Promise<QueuedMessage[]>
    cancelQueued: (worktreeId: string, name: string, chatId: string, id: string) => Promise<void>
    commands: (worktreeId: string, name: string) => Promise<AgentSlashCommand[]>
  }
  fs: {
    watch: (worktreeIds: string[]) => Promise<void>
  }
  files: {
    listDir: (worktreeId: string, relPath: string) => Promise<FileNode[]>
    listAll: (worktreeId: string) => Promise<string[]>
    listPath: (worktreeId: string, rawPath: string) => Promise<FileNode[]>
    read: (worktreeId: string, absPath: string) => Promise<string>
    write: (worktreeId: string, absPath: string, content: string) => Promise<void>
    create: (worktreeId: string, relPath: string) => Promise<string>
    createDir: (worktreeId: string, relPath: string) => Promise<string>
    rename: (worktreeId: string, fromRel: string, toRel: string) => Promise<string>
    delete: (worktreeId: string, relPath: string) => Promise<void>
    saveAttachment: (
      worktreeId: string,
      data: Uint8Array,
      ext: string
    ) => Promise<{ relPath: string }>
    pathForFile: (file: File) => string
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
    inlayHints: (
      worktreeId: string,
      language: string,
      uri: string,
      range: LspRange
    ) => Promise<InlayHint[]>
  }
  terminal: {
    create: (worktreeId: string | null, cols: number, rows: number) => Promise<string>
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    kill: (id: string) => Promise<void>
  }
  nvim: {
    spawn: (worktreeId: string | null) => Promise<string>
    attach: (id: string, cols: number, rows: number, file?: string) => Promise<void>
    input: (id: string, keys: string) => Promise<void>
    inputMouse: (
      id: string,
      button: string,
      action: string,
      modifier: string,
      row: number,
      col: number
    ) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    command: (id: string, command: string) => Promise<void>
    request: (id: string, method: string, args: unknown[]) => Promise<unknown>
    kill: (id: string) => Promise<void>
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
    grants: {
      list: () => Promise<GrantSummaryShape[]>
      revoke: (clientId: string, permission: string) => Promise<GrantSummaryShape[]>
      revokeScope: (clientId: string, path: string) => Promise<GrantSummaryShape[]>
      revokeAll: (clientId: string) => Promise<GrantSummaryShape[]>
    }
  }
  apps: {
    list: () => Promise<ExternalAppShape[]>
    respondPairing: (id: string, approved: boolean) => Promise<void>
    revoke: (appId: string) => Promise<ExternalAppShape[]>
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
