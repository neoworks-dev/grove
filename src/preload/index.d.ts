import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Location,
  WorkspaceEdit,
  TextEdit,
  CodeAction,
  Command,
  InlayHint
} from 'vscode-languageserver-types'
import type { BrowserConnectorStatus, ChromiumBrowserId } from '../shared/browserHost'
import type {
  DebugAdapterInfo,
  DebugBreakpoint,
  DebugBreakpointOptions,
  DebugConfigurationEntry,
  DebugEvaluation,
  DebugOutputLine,
  DebugScope,
  DebugSnapshot,
  DebugStackFrame,
  DebugVariable,
  MasonDebugPackage
} from '../shared/debug'
import type {
  Worktree,
  WorktreeSetupState,
  BranchList,
  BranchStatus,
  BranchCommits,
  GraphPage,
  CommitSearchPage,
  ResetMode,
  RefList,
  StashEntry,
  RefComparison,
  DiffFile,
  DiffSides,
  DiffHunks,
  DiffStats,
  CheckpointMeta,
  TreeFileChange,
  MergeMode,
  MergePreview,
  MergeResult,
  ConflictHunk,
  ConflictProposal,
  ConflictResolutionLines,
  ConflictChoice,
  MergeState,
  PrCheckoutState,
  PrConflictResolution,
  WorktreeChatMessage,
  InlineHunk,
  AppliedRange,
  OpenPrOptions,
  MergePrOptions,
  GithubPrDiff,
  GithubPrFile,
  GithubPrReview,
  GithubReviewDraft,
  GithubReviewEvent,
  GithubStatus,
  GithubStateFilter,
  GithubDashboard,
  GithubItemKind,
  GithubItemDetail,
  GithubItemAction,
  GithubItemCommand,
  GithubLabelDefinition,
  GithubMilestoneDefinition,
  GithubIssueDraft,
  GithubCreatedIssue,
  GithubLabelChange,
  GithubCloseReason,
  GithubAssigneeChange,
  GithubActor,
  ArchiveOptions,
  DockLayoutState,
  WorkbenchConfig,
  ServiceRuntime,
  ServiceConfig,
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
  HunkDecision,
  FileNode,
  RepoInfo,
  CatalogEntry,
  InstalledExtension,
  GrammarPayload,
  LspPosition,
  LspCompletion,
  LspRange,
  LspDiagnostic,
  TerminalSessionInfo,
  BranchPosition,
  BranchPull,
  BrowserPickedElement
} from '../shared/types'
import type {
  BlobDescriptor,
  ClientEventBody,
  CodeLocation,
  CreateSessionOptions,
  FileMatch,
  ResolvedLocation,
  EditedFile,
  ShellCompletion,
  HarnessCatalog,
  HarnessInfo,
  SessionEvent,
  SessionNote,
  PaneTypeInfo,
  ShellOutputSnapshot,
  SessionMeta,
  SessionSnapshot,
  SessionUpdate,
  SessionReplay,
  LineBlame,
  CommitPrompt
} from '../shared/agents'

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
  pinnedTabsByWorktree: Record<string, string[]>
  selectedWorktreeId: string | null
  setupOnceDone: boolean
  trustedSetupHash: string | null
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
  permissions: Partial<Record<import('../shared/plugins').PluginPermission, 'granted' | 'denied'>>
  fsScopes: string[]
}

/** An endpoint the user brought: a base URL that speaks the Anthropic API. */
export interface CustomEndpointShape {
  id: string
  label: string
  baseUrl: string
  keyVariable?: string
  models?: string[]
}

/** Where a debug configuration is listed or started from. */
interface DebugEditorContext {
  worktreeId: string
  activeFile?: string
  activeLine?: number
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
    // Each worktree's commits ahead of and behind the base branch, by worktree id.
    positions: () => Promise<Record<string, BranchPosition>>
    // Setup still running or failed, by worktree id; `event:worktree-setup` streams changes.
    setupStates: () => Promise<Record<string, WorktreeSetupState>>
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
    stageHunk: (worktreeId: string, file: DiffFile, hunkIndex: number) => Promise<void>
    unstageHunk: (worktreeId: string, file: DiffFile, hunkIndex: number) => Promise<void>
    branchStatus: (worktreeId: string) => Promise<BranchStatus>
    pull: (worktreeId: string) => Promise<string>
    fetch: (worktreeId: string) => Promise<string>
    branchCommits: (worktreeId: string, skip: number, limit: number) => Promise<BranchCommits>
    commitFiles: (worktreeId: string, sha: string) => Promise<DiffFile[]>
    graph: (worktreeId: string, skip: number, limit: number) => Promise<GraphPage>
    commitMessage: (worktreeId: string, sha: string) => Promise<string>
    searchCommits: (
      worktreeId: string,
      query: string,
      skip: number,
      limit: number
    ) => Promise<CommitSearchPage>
    checkoutCommit: (worktreeId: string, sha: string) => Promise<Worktree[]>
    createBranch: (
      worktreeId: string,
      name: string,
      sha: string,
      checkout: boolean
    ) => Promise<Worktree[]>
    cherryPick: (worktreeId: string, sha: string) => Promise<string>
    revert: (worktreeId: string, sha: string) => Promise<string>
    reset: (worktreeId: string, sha: string, mode: ResetMode) => Promise<Worktree[]>
    fileAtRevision: (worktreeId: string, revision: string, relPath: string) => Promise<string>
    refs: (worktreeId: string) => Promise<RefList>
    stashes: (worktreeId: string) => Promise<StashEntry[]>
    checkout: (worktreeId: string, branch: string, remote: boolean) => Promise<Worktree[]>
    mergeRef: (worktreeId: string, ref: string) => Promise<MergeResult>
    rebaseOnto: (worktreeId: string, onto: string) => Promise<string>
    deleteBranch: (worktreeId: string, branch: string, force: boolean) => Promise<void>
    stashPush: (worktreeId: string, message: string) => Promise<void>
    stashApply: (worktreeId: string, ref: string, pop: boolean) => Promise<void>
    stashDrop: (worktreeId: string, ref: string) => Promise<void>
    compare: (worktreeId: string, base: string, head: string | null) => Promise<RefComparison>
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
    mergeState: (worktreeId: string) => Promise<MergeState>
    resolveConflict: (
      worktreeId: string,
      relPath: string,
      hunkIndex: number,
      choice: ConflictChoice
    ) => Promise<ConflictHunk[]>
  }
  github: {
    openPr: (worktreeId: string, options: OpenPrOptions) => Promise<string>
    mergePr: (worktreeId: string, options: MergePrOptions) => Promise<string>
    status: () => Promise<GithubStatus>
    dashboard: (options: { state: GithubStateFilter; limit: number }) => Promise<GithubDashboard>
    // Each branch's most recent pull request, by head branch name.
    branchPulls: () => Promise<Record<string, BranchPull>>
    item: (kind: GithubItemKind, number: number) => Promise<GithubItemDetail>
    labels: () => Promise<GithubLabelDefinition[]>
    milestones: () => Promise<GithubMilestoneDefinition[]>
    changeMilestone: (kind: GithubItemKind, number: number, title: string | null) => Promise<void>
    mentionables: () => Promise<GithubActor[]>
    setSubscription: (nodeId: string, subscribed: boolean) => Promise<void>
    command: (kind: GithubItemKind, number: number, command: GithubItemCommand) => Promise<void>
    transfer: (number: number, destination: string) => Promise<string>
    createIssue: (draft: GithubIssueDraft) => Promise<GithubCreatedIssue>
    changeLabels: (kind: GithubItemKind, number: number, change: GithubLabelChange) => Promise<void>
    comment: (kind: GithubItemKind, number: number, body: string) => Promise<string>
    action: (
      kind: GithubItemKind,
      number: number,
      action: GithubItemAction,
      merge?: MergePrOptions,
      reason?: GithubCloseReason
    ) => Promise<string>
    changeAssignees: (
      kind: GithubItemKind,
      number: number,
      change: GithubAssigneeChange
    ) => Promise<void>
    prDiff: (number: number, baseRefName: string) => Promise<GithubPrDiff>
    prBaseFile: (baseOid: string, file: GithubPrFile) => Promise<string>
    checkoutPr: (number: number, baseRefName: string) => Promise<Worktree>
    resolvePrConflicts: (number: number, baseRefName: string) => Promise<PrConflictResolution>
    prCheckoutState: (number: number) => Promise<PrCheckoutState>
    // Fetch the pull request again, then say where its checkout stands.
    refreshPrCheckout: (number: number, baseRefName: string) => Promise<PrCheckoutState>
    // Fast-forward the checkout to the pull request; refuses with the reason otherwise.
    updatePrCheckout: (number: number, baseRefName: string) => Promise<PrCheckoutState>
    pushPrBranch: (number: number) => Promise<string>
    prViewedFiles: (number: number) => Promise<string[]>
    setPrFileViewed: (pullRequestId: string, path: string, viewed: boolean) => Promise<void>
    prReview: (number: number) => Promise<GithubPrReview>
    addPrReviewComment: (
      number: number,
      pullRequestId: string,
      draft: GithubReviewDraft
    ) => Promise<string>
    addPrReviewReply: (number: number, threadId: string, body: string) => Promise<void>
    setPrThreadResolved: (threadId: string, resolved: boolean) => Promise<void>
    deletePrReviewComment: (commentId: string) => Promise<void>
    discardPrReview: (number: number) => Promise<boolean>
    submitPrReview: (
      number: number,
      pullRequestId: string,
      event: GithubReviewEvent,
      body: string
    ) => Promise<void>
  }
  checkpoints: {
    list: (worktreeId: string) => Promise<CheckpointMeta[]>
    snapshot: (worktreeId: string, note?: string) => Promise<CheckpointMeta | null>
    restore: (
      worktreeId: string,
      commit: string
    ) => Promise<{ restoredTree: string; preRestore: CheckpointMeta | null }>
  }
  replay: {
    session: (sessionId: string) => Promise<SessionReplay>
    compare: (sessionId: string, from: string, to: string) => Promise<TreeFileChange[]>
    restore: (
      sessionId: string,
      tree: string
    ) => Promise<{ restoredTree: string; preRestore: CheckpointMeta | null }>
  }
  blame: {
    line: (worktreeId: string, path: string, line: number, text: string) => Promise<LineBlame>
    commitPrompts: (worktreeId: string, sha: string) => Promise<CommitPrompt[]>
  }
  conflicts: {
    agentPrompt: (worktreeId: string, paths: string[] | null) => Promise<string>
    proposals: (worktreeId: string) => Promise<ConflictProposal[]>
    clearProposals: (worktreeId: string) => Promise<void>
    write: (worktreeId: string, resolutions: ConflictResolutionLines[]) => Promise<string[]>
    preview: (
      worktreeId: string,
      path: string,
      resolutions: ConflictResolutionLines[]
    ) => Promise<{ current: string; resolved: string }>
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
    resolveReview: (batchId: string, decisions: HunkDecision[]) => Promise<void>
    discardReview: (batchId: string) => Promise<void>

    harnesses: () => Promise<HarnessInfo[]>
    catalog: (harnessId: string) => Promise<HarnessCatalog>

    listSessions: () => Promise<SessionMeta[]>
    createSession: (options: CreateSessionOptions) => Promise<SessionSnapshot>
    getSession: (sessionId: string) => Promise<SessionSnapshot>
    updateSession: (
      sessionId: string,
      changes: SessionUpdate
    ) => Promise<{ changed: string[]; session: SessionSnapshot }>
    deleteSession: (sessionId: string) => Promise<void>

    listEvents: (sessionId: string, after: number) => Promise<SessionEvent[]>
    sendEvents: (sessionId: string, events: ClientEventBody[]) => Promise<{ lastSeq: number }>
    saveNotes: (sessionId: string, notes: SessionNote[]) => Promise<void>
    setPaneTypes: (types: PaneTypeInfo[]) => Promise<void>
    /** What the session's running commands have printed so far. */
    shellOutput: (sessionId: string) => Promise<ShellOutputSnapshot[]>
    /** Ctrl+C for a command the session is running; false when there was none. */
    interruptShell: (sessionId: string, toolUseId: string) => Promise<boolean>
    /** Sends the commands the session's agent is waiting on to the background (Ctrl+B). */
    backgroundShell: (sessionId: string) => Promise<boolean>
    /** Types into a running command of the session. */
    writeShell: (sessionId: string, toolUseId: string, data: string) => Promise<boolean>
    /** Resizes a running command's terminal to the view showing it. */
    resizeShell: (sessionId: string, toolUseId: string, cols: number, rows: number) => Promise<boolean>
    /** Where places an agent pointed at are now, after edits, renames and deletions. */
    resolveLocations: (
      worktreeId: string,
      locations: CodeLocation[]
    ) => Promise<ResolvedLocation[]>
    /** Every file the session has edited, with the lines its edits added and removed. */
    editedFiles: (sessionId: string) => Promise<EditedFile[]>
    /** A file the session edited, as it would be without those edits. */
    editedFileBase: (sessionId: string, path: string) => Promise<string>

    completeShell: (sessionId: string, line: string) => Promise<ShellCompletion[]>
    shellName: () => Promise<string>
    searchFiles: (sessionId: string, query: string, limit?: number) => Promise<FileMatch[]>
    uploadBlob: (
      sessionId: string,
      bytes: Uint8Array,
      mediaType: string,
      filename?: string
    ) => Promise<BlobDescriptor>
  }
  fs: {
    watch: (worktreeIds: string[]) => Promise<void>
  }
  files: {
    listDir: (worktreeId: string, relPath: string) => Promise<FileNode[]>
    listAll: (worktreeId: string) => Promise<string[]>
    listPath: (worktreeId: string, rawPath: string) => Promise<FileNode[]>
    /** Of the worktree-relative paths given, the ones that are files in the worktree. */
    existing: (worktreeId: string, relPaths: string[]) => Promise<string[]>
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
    /** Terminals still running, including those started before this window. */
    list: () => Promise<TerminalSessionInfo[]>
    /** Take one over; resolves with the output printed while grove was away. */
    attach: (id: string, cols: number, rows: number) => Promise<string>
  }
  debugger: {
    snapshot: () => Promise<DebugSnapshot>
    output: () => Promise<DebugOutputLine[]>
    clearOutput: () => Promise<void>
    /** Launch configurations for a worktree, with the editor's file for current-file ones. */
    configurations: (editor: DebugEditorContext) => Promise<DebugConfigurationEntry[]>
    adapters: () => Promise<DebugAdapterInfo[]>
    masonPackages: () => Promise<MasonDebugPackage[]>
    installAdapter: (masonPackage: string) => Promise<void>
    /** Starts a configuration; resolves with the session's id once it runs. */
    start: (editor: DebugEditorContext, configuration: Record<string, unknown>) => Promise<string>
    stop: (sessionId?: string) => Promise<void>
    restart: (sessionId?: string) => Promise<void>
    continue: (sessionId?: string, threadId?: number) => Promise<void>
    pause: (sessionId?: string, threadId?: number) => Promise<void>
    stepOver: (sessionId?: string, threadId?: number) => Promise<void>
    stepInto: (sessionId?: string, threadId?: number) => Promise<void>
    stepOut: (sessionId?: string, threadId?: number) => Promise<void>
    focus: (sessionId: string, threadId: number | null, frameId: number | null) => Promise<void>
    setExceptionFilters: (sessionId: string, filters: string[]) => Promise<void>
    stackTrace: (
      sessionId: string,
      threadId: number,
      startFrame: number,
      levels: number
    ) => Promise<{ frames: DebugStackFrame[]; total: number | null }>
    scopes: (sessionId?: string, frameId?: number) => Promise<DebugScope[]>
    variables: (sessionId: string, variablesReference: number) => Promise<DebugVariable[]>
    evaluate: (
      expression: string,
      context: 'repl' | 'watch' | 'hover',
      sessionId?: string,
      frameId?: number
    ) => Promise<DebugEvaluation>
    toggleBreakpoint: (path: string, line: number) => Promise<void>
    setBreakpoint: (
      path: string,
      line: number,
      options: DebugBreakpointOptions
    ) => Promise<DebugBreakpoint>
    removeBreakpoint: (id: string) => Promise<void>
    removeAllBreakpoints: () => Promise<void>
    setBreakpointEnabled: (id: string, enabled: boolean) => Promise<void>
    addWatch: (expression: string) => Promise<void>
    removeWatch: (expression: string) => Promise<void>
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
      col: number,
      grid?: number
    ) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    command: (id: string, command: string) => Promise<void>
    request: (id: string, method: string, args: unknown[]) => Promise<unknown>
    kill: (id: string) => Promise<void>
    /** The step first-run setup is on, or null when none is running. */
    setupStep: () => Promise<string | null>
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
  endpoints: {
    list: () => Promise<CustomEndpointShape[]>
    save: (endpoint: CustomEndpointShape) => Promise<CustomEndpointShape[]>
    remove: (id: string) => Promise<CustomEndpointShape[]>
    probe: (baseUrl: string, keyVariable?: string) => Promise<{ models: string[] | null }>
  }
  secrets: {
    status: (names: string[]) => Promise<{ present: string[]; storable: boolean }>
    set: (name: string, value: string) => Promise<void>
    clear: (name: string) => Promise<void>
  }
  settings: {
    read: () => Promise<SettingsSnapshotShape>
    set: (key: string, value: unknown, scope: 'user' | 'project') => Promise<SettingsSnapshotShape>
    // The scope's settings file, created if missing; null for project scope with no repo.
    filePath: (scope: 'user' | 'project') => Promise<string | null>
  }
  browser: {
    /** Hands a worktree's preview page to the main process, replacing any earlier one. */
    attach: (worktreeId: string, contentsId: number) => Promise<void>
    detach: (worktreeId: string, contentsId: number) => Promise<void>
    /** Lets the user point at an element; null when they pressed Escape. */
    pick: (worktreeId: string) => Promise<BrowserPickedElement | null>
    cancelPick: (worktreeId: string) => Promise<void>
  }
  browserHost: {
    status: () => Promise<BrowserConnectorStatus>
    /** Writes the host manifest for one browser, copying the host and extension first. */
    install: (browser: ChromiumBrowserId) => Promise<BrowserConnectorStatus>
    /** Deletes the host manifest for one browser. */
    remove: (browser: ChromiumBrowserId) => Promise<BrowserConnectorStatus>
    /** Opens the unpacked extension's folder in the file manager. */
    revealExtension: () => Promise<void>
  }
  openExternal: (url: string) => Promise<void>
  // Bring grove's window to the front, e.g. from a desktop notification.
  raiseWindow: () => Promise<void>
  // True when the app was started with GROVE_DEBUG=1; gates the renderer's
  // debug hooks on window.
  debug: boolean
  on: (channel: string, callback: (payload: unknown) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    workbench: WorkbenchApi
  }
}
