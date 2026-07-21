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

// ── settings ────────────────────────────────────────────────────

export interface SettingsApi {
  // Keys are automatically prefixed with the plugin id.
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown, scope?: 'user' | 'project'): Promise<void>
  onChange(key: string, callback: (value: unknown) => void): Disposable
}

// ── events ──────────────────────────────────────────────────────

export type GroveEvent = 'workspace.didChangeWorktree' | 'files.didChange' | 'theme.didChange'

export interface EventsApi {
  on(event: GroveEvent, callback: (payload: unknown) => void): Disposable
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
  settings: SettingsApi
  events: EventsApi
}
