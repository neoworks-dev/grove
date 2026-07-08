import { ElectronAPI } from '@electron-toolkit/preload'
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
  PermissionDecision,
  FileNode,
  RepoInfo
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
  paneSizes: Record<string, number>
  panelsOpen: Record<string, boolean>
  centerView: string | null
  activeView: string | null
}

export interface WorkbenchApi {
  repo: {
    pick: () => Promise<OpenRepoResult | null>
    open: (repoPath: string) => Promise<OpenRepoResult>
    last: () => Promise<string | null>
  }
  worktrees: {
    list: () => Promise<Worktree[]>
    create: (options: {
      name: string
      baseBranch: string
      newBranch?: string
    }) => Promise<Worktree>
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
    start: (
      worktreeId: string,
      name: string,
      options: AgentLaunchOptions
    ) => Promise<AgentRuntime>
    stop: (worktreeId: string, name: string) => Promise<void>
    reset: (worktreeId: string, name: string) => Promise<void>
    transcript: (worktreeId: string, name: string) => Promise<string[]>
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
  search: {
    ripgrep: (worktreeId: string, query: string, reqId: string) => Promise<void>
    cancel: () => Promise<void>
  }
  state: {
    getRepo: () => Promise<RepoStateShape>
    update: (patch: Partial<RepoStateShape>) => Promise<RepoStateShape>
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
