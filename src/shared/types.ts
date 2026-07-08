// Types shared across main, preload, and renderer.

export interface Worktree {
  id: string // stable id derived from path
  name: string // last path segment
  path: string
  branch: string // branch name or detached HEAD short sha
  isMain: boolean
  isDetached: boolean
  locked: boolean
  dirty: boolean
  portSlot: number // deterministic port-allocation slot
}

export interface BranchList {
  current: string
  all: string[]
  local: string[]
}

export type DiffChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export interface DiffFile {
  path: string
  oldPath?: string // for renames
  changeType: DiffChangeType
  staged: boolean
}

export interface DiffSides {
  path: string
  original: string // content at base/HEAD (empty for added/untracked)
  modified: string // working-tree or staged content
  language: string
}

// ── Config schema (repo-root YAML) ──────────────────────────────

export interface WorkbenchConfig {
  workbench: {
    worktrees_dir: string
    default_base_branch: string
  }
  ports: {
    start: number
    count_per_worktree: number
  }
  setup: {
    once: string[]
    per_worktree: string[]
  }
  services: Record<string, ServiceConfig>
  agents: Record<string, AgentConfig>
}

export interface ServiceConfig {
  command: string
  preview?: string
  health?: string
  log?: string
}

// A selectable agent option (mode / model / effort). `value` is the concrete
// value passed to the SDK when chosen (e.g. a permission mode or effort level).
export interface AgentOption {
  label: string
  value: string
}

export interface AgentConfig {
  command: string // adapter id / display name
  interactive?: boolean // supports live permission prompts (claude)
  modes?: AgentOption[]
  models?: AgentOption[]
  efforts?: AgentOption[]
}

// Structured launch options sent from the renderer (replaces CLI flag strings).
export interface AgentLaunchOptions {
  prompt?: string
  mode?: string
  model?: string
  effort?: string
}

// ── Interactive permissions (agent → user → agent) ──────────────

export interface PermissionRequestEvent {
  id: string // resolve target
  worktreeId: string
  agent: string
  toolName: string
  title: string
  path: string | null
  input: Record<string, unknown>
}

export type PermissionDecision =
  | { behavior: 'allow'; remember: boolean }
  | { behavior: 'deny'; message: string }

// ── Interactive dialogs (agent → user → agent) ──────────────────
// The claude SDK surfaces questions (and other blocking dialogs) via its
// `onUserDialog` callback, separate from tool permissions. `dialogKind` selects
// the renderer; `payload`/`result` shapes are defined by the SDK per kind (the
// question kind carries a `questions` array). Kept opaque so new kinds work.

export interface AgentDialogRequest {
  id: string
  worktreeId: string
  agent: string
  dialogKind: string
  payload: Record<string, unknown>
}

export type AgentDialogDecision =
  | { behavior: 'completed'; result: unknown }
  | { behavior: 'cancelled' }

// ── Runtime state ───────────────────────────────────────────────

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'unhealthy'

export interface ServiceRuntime {
  worktreeId: string
  name: string
  status: ServiceStatus
  pid: number | null
  previewUrl: string | null
  healthUrl: string | null
  logPath: string
  ports: number[]
}

export type AgentStatus = 'stopped' | 'running' | 'exited' | 'error'

export interface AgentRuntime {
  worktreeId: string
  name: string
  status: AgentStatus
  pid: number | null
  command: string
  exitCode: number | null
  logPath: string
}

export interface FileNode {
  name: string
  path: string // absolute
  relPath: string // relative to worktree root
  isDir: boolean
}

// A ripgrep content-search hit (file is relative to the search root).
export interface SearchMatch {
  file: string
  line: number
  column: number
  text: string
}

// ── Editor extensions (grammars / themes / LSP servers) ─────────

export interface CatalogEntry {
  id: string
  kind: 'grammar' | 'theme' | 'lsp'
  name: string
  description?: string
  license?: string
  extensions?: string[] // grammar file extensions
  wasmUrl?: string
  highlightsUrl?: string
  scheme?: 'dark' | 'light' // theme
  palette?: Record<string, string> // theme partial palette overrides
  lsp?: { command: string; args?: string[]; languages: string[]; install?: string }
}

export interface InstalledExtension {
  id: string
  kind: string
  enabled: boolean
}

export interface GrammarPayload {
  wasm: Uint8Array
  highlights: string
}

// ── IPC event payloads (main → renderer) ────────────────────────

export interface LogLineEvent {
  worktreeId: string
  source: 'service' | 'agent'
  name: string
  line: string
}

export interface ServiceStatusEvent {
  runtime: ServiceRuntime
}

export interface AgentStatusEvent {
  runtime: AgentRuntime
}

export interface RepoInfo {
  path: string
  name: string
  currentBranch: string
}
