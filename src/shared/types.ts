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

export interface AgentConfig {
  command: string
}

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
