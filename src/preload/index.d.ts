import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Worktree,
  BranchList,
  DiffFile,
  DiffSides,
  WorkbenchConfig,
  ServiceRuntime,
  AgentRuntime,
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
  selectedWorktreeId: string | null
  setupOnceDone: boolean
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
    start: (worktreeId: string, name: string, prompt?: string) => Promise<AgentRuntime>
    stop: (worktreeId: string, name: string) => Promise<void>
    active: () => Promise<string[]>
  }
  files: {
    listDir: (worktreeId: string, relPath: string) => Promise<FileNode[]>
    read: (worktreeId: string, absPath: string) => Promise<string>
    write: (worktreeId: string, absPath: string, content: string) => Promise<void>
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
