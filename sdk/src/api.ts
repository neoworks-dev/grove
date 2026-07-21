// The Grove plugin API surface. Plugins import '@grove/plugin-sdk' and receive
// this API, implemented by the host-injected runtime (globalThis.__grove) —
// plugin bundles never contain protocol logic, only this typed facade.
//
// Entry contract for a plugin's worker bundle:
//   export function activate(context: PluginContext): void | Promise<void>
//   export function deactivate?(): void | Promise<void>

export interface Disposable {
  dispose(): void
}

export interface CancellationToken {
  readonly isCancelled: boolean
  onCancel(callback: () => void): Disposable
}

export interface PluginStorage {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface PluginContext {
  readonly pluginId: string
  // Disposed automatically on deactivate.
  readonly subscriptions: Disposable[]
  // Requires the 'state' permission.
  readonly storage: PluginStorage
}

// ── commands ────────────────────────────────────────────────────

export interface CommandsApi {
  register(id: string, handler: (...args: unknown[]) => unknown): Disposable
  // Executes any registered command, including core and other plugins'.
  execute(id: string, ...args: unknown[]): Promise<unknown>
}

// ── keybindings ─────────────────────────────────────────────────

export interface KeybindingRegistration {
  id: string
  // Canonical sequence grammar, e.g. "leader a b", "ctrl+k ctrl+s".
  keys: string
  context?: string
  group?: string
  description: string
  command: string
}

export interface KeybindingsApi {
  register(binding: KeybindingRegistration): Disposable
}

// ── ui.overlays ─────────────────────────────────────────────────

export interface OverlayItem {
  id: string
  label: string
  description?: string
  detail?: string
  icon?: string
  data?: unknown
}

export type OverlayPreview =
  | {
      kind: 'excerpt'
      file: string
      lines: { n: number; text: string }[]
      highlightLine?: number
    }
  | { kind: 'text'; text: string }

export interface OverlayHandler {
  onQuery(
    query: string,
    emit: (items: OverlayItem[]) => void,
    token: CancellationToken
  ): Promise<void>
  onPreview?(item: OverlayItem, token: CancellationToken): Promise<OverlayPreview | null>
  onAccept(items: OverlayItem[]): Promise<void>
}

export interface OverlayDescriptor {
  id: string
  title: string
  placeholder?: string
  preview?: boolean
  multiSelect?: boolean
  debounceMs?: number
}

export interface OverlaysApi {
  register(descriptor: OverlayDescriptor, handler: OverlayHandler): Disposable
  // Binds behavior to an overlay declared in the manifest.
  setHandler(id: string, handler: OverlayHandler): Disposable
  open(id: string): Promise<void>
  close(id: string): Promise<void>
}

// ── ui.statusBar / ui.sidebar / ui.menu ─────────────────────────

export interface StatusBarItem {
  id: string
  align: 'left' | 'right'
  order?: number
  text: string
  tooltip?: string
  command?: string
}

export interface StatusBarApi {
  addItem(item: StatusBarItem): Disposable
  update(id: string, patch: { text?: string; tooltip?: string }): void
}

export interface SidebarApi {
  addItem(item: {
    id: string
    label: string
    icon: string
    order?: number
    command: string
  }): Disposable
}

export interface MenuApi {
  addItem(item: {
    id: string
    menuId: string
    label: string
    group?: string
    order?: number
    command: string
  }): Disposable
}

// ── ui.dialogs / notifications ──────────────────────────────────

export interface DialogAction {
  id: string
  label: string
  kind?: 'primary' | 'danger' | 'default'
}

export interface DialogsApi {
  // Resolves with the picked action id (or 'cancel' on dismiss).
  confirm(options: {
    title: string
    body: string
    detail?: string
    actions: DialogAction[]
  }): Promise<string>
}

export interface UiApi {
  overlays: OverlaysApi
  statusBar: StatusBarApi
  sidebar: SidebarApi
  menu: MenuApi
  dialogs: DialogsApi
  notify(options: { level: 'info' | 'warn' | 'error'; message: string; timeoutMs?: number }): void
}

// ── panes (declarative surfaces) ────────────────────────────────

export type SurfaceNode =
  | { type: 'stack'; direction: 'row' | 'column'; children: SurfaceNode[] }
  | { type: 'text'; text: string; style?: 'default' | 'muted' | 'mono' }
  | {
      type: 'list'
      items: { id: string; label: string; description?: string }[]
      // Command executed with the picked item id as argument.
      onSelect?: string
    }
  | { type: 'button'; label: string; command: string }

export interface PanesApi {
  registerPaneType(
    id: string,
    render: (token: CancellationToken) => Promise<SurfaceNode>
  ): Disposable
  // Asks the host to re-invoke render for all leaves showing this pane type.
  update(id: string): void
}

// ── views ───────────────────────────────────────────────────────

export interface ViewsApi {
  register(view: { id: string; label: string; order?: number; tree: unknown }): Disposable
}

// ── workspace ───────────────────────────────────────────────────

export interface WorktreeInfo {
  id: string
  path: string
  branch: string
}

export interface SearchMatch {
  file: string
  line: number
  column: number
  text: string
}

export interface WorkspaceApi {
  getCurrentWorktree(): Promise<WorktreeInfo | null>
  // 'workspace.read'. Relative paths, capped by the host.
  findFiles(options?: { worktreeId?: string }): Promise<string[]>
  searchText(
    query: string,
    options?: { worktreeId?: string; token?: CancellationToken }
  ): AsyncIterable<SearchMatch>
  readFile(path: string, options?: { worktreeId?: string }): Promise<string>
  readExcerpt(
    path: string,
    startLine: number,
    endLine: number,
    options?: { worktreeId?: string }
  ): Promise<{ n: number; text: string }[]>
  // 'workspace.write'.
  writeFile(path: string, content: string, options?: { worktreeId?: string }): Promise<void>
  // UI-only (opens an editor tab); not permission-gated.
  openFile(path: string, options?: { worktreeId?: string; line?: number }): Promise<void>
  // The file open in the active editor, as a worktree-relative path plus the
  // 1-based cursor line. Null when no editor is focused or the buffer is unnamed.
  getActiveFile(): Promise<{ path: string; line: number } | null>
}

// ── ai ──────────────────────────────────────────────────────────

export interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface McpToolSpec {
  name: string
  description: string
  inputSchema: JsonSchemaObject
  handler(input: unknown): Promise<{ content: { type: 'text'; text: string }[] }>
}

export interface AiApi {
  // 'ai.prompt': one-shot mediated run, never touches the user's chats. Tool
  // calls route through the standard permission dialog tagged with the plugin.
  prompt(
    request: { prompt: string; worktreeId?: string; model?: string; systemAppend?: string },
    token?: CancellationToken
  ): AsyncIterable<{ type: string; payload: unknown }>
  // 'ai.skills': injected into subsequent agent runs.
  registerSkill(skill: { name: string; description: string; instructions: string }): Disposable
  // 'ai.mcp': tool schemas go to the host; handlers stay in this worker and
  // are invoked over RPC while an agent runs.
  registerMcpServer(server: { name: string; tools: McpToolSpec[] }): Disposable
}

// ── shared position/range primitives ────────────────────────────
// 1-based lines and columns, matching getActiveFile/readExcerpt.

export interface Position {
  line: number
  column: number
}

export interface Range {
  start: Position
  end: Position
}

export interface WorktreeScoped {
  // Defaults to the active worktree when omitted.
  worktreeId?: string
}

// ── editor (nvim-backed documents) ──────────────────────────────
// Documents are identified by worktree-relative path; version is a
// host-minted revision (bridged from nvim's changedtick — the tick itself
// never crosses the boundary as an nvim handle, only as this number).
// Mutations carry the version the caller read and come back 'stale' instead
// of applying blind when the buffer moved underneath them.

export interface TextDocumentInfo {
  worktreeId: string
  path: string
  version: number
  lineCount: number
  // Open string ('typescript', 'rust', …) — discovered, not a closed union.
  languageId: string
  dirty: boolean
}

export interface EditorInfo {
  document: TextDocumentInfo
  active: boolean
  // A cursor is an empty range.
  selections: Range[]
}

export type EditResult =
  | { status: 'applied'; version: number }
  | { status: 'stale'; currentVersion: number }

export interface TextEdit {
  range: Range
  newText: string
}

export interface DecorationSpec {
  range: Range
  // Semantic style name ('info', 'warning', 'error', 'hint', 'added',
  // 'removed', …) — never raw colors or highlight groups.
  style: string
  hoverMessage?: string
}

export interface EditorApi {
  // 'editor.read'
  listEditors(): Promise<EditorInfo[]>
  getActiveEditor(): Promise<EditorInfo | null>
  // Loads the buffer without stealing focus; returns the snapshot version.
  openDocument(path: string, options?: WorktreeScoped): Promise<TextDocumentInfo>
  readDocument(
    path: string,
    options?: WorktreeScoped
  ): Promise<{ document: TextDocumentInfo; lines: string[] }>
  getSelections(path: string, options?: WorktreeScoped): Promise<Range[]>

  // 'editor.edit' — ranged replacements, all-or-nothing.
  applyEdit(edit: {
    path: string
    worktreeId?: string
    expectedVersion: number
    edits: TextEdit[]
  }): Promise<EditResult>
  save(path: string, options?: WorktreeScoped & { expectedVersion?: number }): Promise<EditResult>
  setSelections(
    path: string,
    selections: Range[],
    options?: WorktreeScoped & { expectedVersion?: number }
  ): Promise<EditResult>
  // Keyed with replace semantics: the same (plugin, key, path) fully
  // replaces earlier decorations; an empty array clears them.
  setDecorations(
    key: string,
    path: string,
    decorations: DecorationSpec[],
    options?: WorktreeScoped
  ): Promise<void>
  // UI-only focus/reveal.
  show(path: string, options?: WorktreeScoped & { line?: number }): Promise<void>
}

// ── git ─────────────────────────────────────────────────────────
// statusVersion is a per-worktree generation counter bumped on every index/
// HEAD change; commit requires the version the caller saw so a plugin can
// never commit a staged set it didn't read.

export interface GitFileChange {
  path: string
  // Open string: 'modified', 'added', 'deleted', 'renamed', …
  status: string
  staged: boolean
}

export interface GitStatus {
  worktreeId: string
  branch: string
  dirty: boolean
  version: number
  files: GitFileChange[]
}

export interface DiffHunkLine {
  kind: 'context' | 'add' | 'del'
  text: string
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffHunkLine[]
}

export type GitMutationResult<T = undefined> =
  | { status: 'ok'; version: number; result?: T }
  | { status: 'stale'; currentVersion: number }

export interface CheckpointInfo {
  id: string
  label: string
  createdAt: number
}

export interface GitApi {
  // 'git.read'
  status(options?: WorktreeScoped): Promise<GitStatus>
  branches(options?: WorktreeScoped): Promise<{ current: string; all: string[] }>
  diffFile(
    path: string,
    options?: WorktreeScoped & { staged?: boolean }
  ): Promise<{ hunks: DiffHunk[]; stats: { additions: number; deletions: number } }>
  fileAtRef(path: string, ref: string, options?: WorktreeScoped): Promise<string>

  // 'git.write'
  stage(
    paths: string[],
    options?: WorktreeScoped & { expectedStatusVersion?: number }
  ): Promise<GitMutationResult>
  unstage(
    paths: string[],
    options?: WorktreeScoped & { expectedStatusVersion?: number }
  ): Promise<GitMutationResult>
  commit(
    message: string,
    options: WorktreeScoped & { expectedStatusVersion: number }
  ): Promise<GitMutationResult<{ sha: string }>>
  // No version token: the remote rejects non-fast-forward pushes natively.
  push(options?: WorktreeScoped): Promise<{ status: 'ok' } | { status: 'rejected'; reason: string }>

  worktrees: {
    // 'git.read'
    list(): Promise<WorktreeInfo[]>
    // 'worktrees.manage'
    create(options: { branch: string; base?: string }): Promise<WorktreeInfo>
    remove(worktreeId: string): Promise<void>
    archive(worktreeId: string): Promise<void>
  }

  checkpoints: {
    // 'git.read'
    list(options?: WorktreeScoped): Promise<CheckpointInfo[]>
    // 'git.write'; restore additionally requires the user to confirm a
    // non-bypassable dialog per invocation (it destroys uncommitted work).
    snapshot(options?: WorktreeScoped & { label?: string }): Promise<{ id: string }>
    restore(checkpointId: string, options?: WorktreeScoped): Promise<void>
  }
}

// ── agents ──────────────────────────────────────────────────────
// Everything a client sends into a chat or channel is host-stamped with the
// client identity; permission/dialog responses are deliberately not exposed.

export interface AgentChatInfo {
  id: string
  worktreeId: string
  title: string
  model?: string
  running: boolean
}

export interface AgentTranscriptEvent {
  // Open string: 'text', 'tool-call', 'status', …
  type: string
  payload: unknown
}

export interface AgentsApi {
  // 'agents.read'
  listChats(options?: WorktreeScoped): Promise<AgentChatInfo[]>
  listModels(): Promise<{ id: string; label: string }[]>
  readTranscript(chatId: string): Promise<AgentTranscriptEvent[]>
  isRunning(chatId: string): Promise<boolean>
  // Streams a live run; ends when the run ends.
  observe(chatId: string, token?: CancellationToken): AsyncIterable<AgentTranscriptEvent>
  channelHistory(options?: WorktreeScoped): Promise<AgentTranscriptEvent[]>

  // 'agents.run'
  createChat(options?: WorktreeScoped & { title?: string; model?: string }): Promise<{ chatId: string }>
  send(chatId: string, message: string): Promise<void>
  stop(chatId: string): Promise<void>
  cancelQueued(chatId: string, queueId: string): Promise<void>
  sendChannelMessage(text: string, options?: WorktreeScoped): Promise<void>
}

// ── terminals ───────────────────────────────────────────────────
// 'terminal.exec' throughout. Clients only ever touch terminals they
// created; those terminals surface in the terminal panel labeled with the
// client identity, and cwd is confined to the worktree.

export interface TerminalsApi {
  create(
    options?: WorktreeScoped & { name?: string; command?: string; cols?: number; rows?: number }
  ): Promise<{ terminalId: string }>
  write(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  kill(terminalId: string): Promise<void>
  // Streams output of an owned terminal; ends when it exits.
  read(terminalId: string, token?: CancellationToken): AsyncIterable<{ data: string }>
}

// ── languages (LSP-backed) ──────────────────────────────────────
// Queries need 'languages.read'. Mutating verbs (rename/format/code action)
// additionally need 'editor.edit': results are applied through the editor
// pipeline all-or-nothing, never handed to the client as raw workspace
// edits. actionIds are short-lived host handles bound to the document
// version they were queried at.

export interface LocationResult {
  path: string
  worktreeId: string
  range: Range
}

export interface CompletionItem {
  label: string
  kind: string
  detail?: string
  insertText?: string
}

export interface CodeActionInfo {
  actionId: string
  title: string
  kind: string
}

export interface LanguagesApi {
  hover(
    path: string,
    position: Position,
    options?: WorktreeScoped
  ): Promise<{ contents: string } | null>
  definition(path: string, position: Position, options?: WorktreeScoped): Promise<LocationResult[]>
  references(path: string, position: Position, options?: WorktreeScoped): Promise<LocationResult[]>
  implementation(
    path: string,
    position: Position,
    options?: WorktreeScoped
  ): Promise<LocationResult[]>
  typeDefinition(
    path: string,
    position: Position,
    options?: WorktreeScoped
  ): Promise<LocationResult[]>
  completion(path: string, position: Position, options?: WorktreeScoped): Promise<CompletionItem[]>
  inlayHints(
    path: string,
    range: Range,
    options?: WorktreeScoped
  ): Promise<{ position: Position; label: string }[]>
  codeActions(path: string, range: Range, options?: WorktreeScoped): Promise<CodeActionInfo[]>

  rename(
    path: string,
    position: Position,
    newName: string,
    options: WorktreeScoped & { expectedVersion: number }
  ): Promise<EditResult & { changedFiles?: string[] }>
  format(path: string, options: WorktreeScoped & { expectedVersion: number }): Promise<EditResult>
  applyCodeAction(actionId: string, options: { expectedVersion: number }): Promise<EditResult>
}

// ── services (dev services) ─────────────────────────────────────

export interface ServiceInfo {
  serviceId: string
  worktreeId: string
  name: string
  // Open string: 'running', 'stopped', 'starting', 'unhealthy', …
  status: string
  ports: number[]
  health?: { ok: boolean; detail?: string }
}

export interface ServicesApi {
  // 'services.read'
  list(options?: WorktreeScoped): Promise<ServiceInfo[]>
  readLogs(
    serviceId: string,
    options?: { follow?: boolean },
    token?: CancellationToken
  ): AsyncIterable<{ line: string }>
  // 'services.manage'
  start(serviceId: string): Promise<void>
  stop(serviceId: string): Promise<void>
}

// ── settings ────────────────────────────────────────────────────

export interface SettingsApi {
  // Keys are automatically prefixed with the plugin id.
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown, scope?: 'user' | 'project'): Promise<void>
  onChange(key: string, callback: (value: unknown) => void): Disposable
}

// ── events ──────────────────────────────────────────────────────

// Known event names get autocompletion; the union stays open (string & {})
// because topics are discovered, and delivery is scope-filtered per client
// (no 'editor.*' events without 'editor.read', etc.).
export type KnownGroveEvent =
  | 'workspace.didChangeWorktree'
  | 'files.didChange'
  | 'theme.didChange'
  | 'editor.didOpenDocument'
  | 'editor.didCloseDocument'
  | 'editor.didChangeDocument'
  | 'editor.didChangeSelection'
  | 'editor.didSaveDocument'
  | 'git.didChangeStatus'
  | 'worktrees.didChange'
  | 'checkpoints.didChange'
  | 'agents.didStartRun'
  | 'agents.didEndRun'
  | 'agents.didChangeChats'
  | 'terminal.didExit'
  | 'services.didChangeStatus'

export type GroveEvent = KnownGroveEvent | (string & {})

export interface EventsApi {
  on(event: GroveEvent, callback: (payload: unknown) => void): Disposable
  // Streamed subscription over the shared event hub; topics are prefixes
  // ('git.', 'editor.didChangeDocument'). Ends on dispose/cancel.
  subscribe(
    topics: GroveEvent[],
    token?: CancellationToken
  ): AsyncIterable<{ topic: string; payload: unknown; worktreeId?: string }>
}

// ── root ────────────────────────────────────────────────────────

export interface GroveApi {
  readonly version: string
  commands: CommandsApi
  keybindings: KeybindingsApi
  ui: UiApi
  panes: PanesApi
  views: ViewsApi
  workspace: WorkspaceApi
  ai: AiApi
  editor: EditorApi
  git: GitApi
  agents: AgentsApi
  terminals: TerminalsApi
  languages: LanguagesApi
  services: ServicesApi
  settings: SettingsApi
  events: EventsApi
}
