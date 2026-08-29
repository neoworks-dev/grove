// The service contracts main-process route plugins inject. The implementations
// are the subsystems constructed in ipc.ts, which provides them on the kernel;
// route plugins only ever see these interfaces.

import type { Worktree, WorkbenchConfig, RepoInfo } from '../../shared/types'
import type { ServiceSupervisor } from '../services'
import type { CheckpointManager } from '../checkpoints'
import type { ReviewService } from '../review'
import type { SettingsService } from '../settings'
import type { TerminalManager } from '../terminals'
import type { NeovimManager } from '../nvim'
import type { LspManager } from '../lsp'
import type { WorktreeWatcher } from '../watcher'
import type { WorktreeChannel } from '../worktreeChannel'
import type { ActionRunner } from '../actions'
import type { AgentService } from '../agents/service'
import type { AgentReviewBridge } from '../agents/reviewBridge'
import type { HarnessRegistry } from '../agents/harness'
import type { PermissionBroker } from '../api/broker'
import type { PluginRegistry } from '../plugins/loader'
import type { AiBridge } from '../plugins/aiBridge'
import type { ApiDispatcher } from '../api/dispatcher'
import type { RouteRegistry } from '../api/registry'
import type { ClientRecord } from '../api/clients'
import type { AppPairing } from '../api/socket/pairing'

/** Repository context plus the lookups every route needs to resolve a worktree. */
export interface WorkbenchService {
  /** Push an event to every open renderer. */
  send(channel: string, payload: unknown): void
  /** The open repository, or an error when none is. */
  requireRepo(): { repoPath: string; config: WorkbenchConfig }
  findWorktree(worktreeId: string): Worktree
  refreshWorktrees(): Promise<Worktree[]>
  /** Re-read workbench.yaml and adopt it as the open repo's config. */
  reloadConfig(): Promise<WorkbenchConfig>
  openRepo(repoPath: string): Promise<{ info: RepoInfo; worktrees: Worktree[] }>
  readonly repoPath: string | null
  readonly worktrees: Worktree[]
}

/** Neovim sidecars plus the session↔worktree bookkeeping the editor API reads. */
export interface NvimService {
  readonly manager: NeovimManager
  /** Remember which worktree a session belongs to. */
  bind(sessionId: string, worktreeId: string | null): void
  /** Mark a session as the worktree's most recently active one. */
  trackActivity(sessionId: string): void
}

/** Plugin registry, permission broker and the API dispatcher behind them. */
export interface PluginsService {
  readonly registry: PluginRegistry
  readonly broker: PermissionBroker
  readonly aiBridge: AiBridge
  readonly dispatcher: ApiDispatcher
  readonly apiRoutes: RouteRegistry
  /** Serializable plugin list for the renderer host. */
  list(): unknown[]
  /** Host-stamped identity for a worker-transport call. */
  client(pluginId: string): ClientRecord
  /** Every client that can hold a grant: plugins and paired external apps. */
  grantClients(): Promise<ClientRecord[]>
}

/** External-app pairing and the local API socket they connect over. */
export interface AppsService {
  readonly pairing: AppPairing
  /** Path of the local API socket, once it is listening. */
  socketPath(): string | null
  /** Drop a client's live socket connections. */
  dropClient(clientId: string): void
}

declare module '@neoworks/extension-system' {
  interface Context {
    workbench: WorkbenchService
    supervisor: ServiceSupervisor
    checkpoints: CheckpointManager
    review: ReviewService
    settings: SettingsService
    terminals: TerminalManager
    nvim: NvimService
    lsp: LspManager
    watcher: WorktreeWatcher
    chat: WorktreeChannel
    actions: ActionRunner
    agents: AgentService
    harnesses: HarnessRegistry
    agentReview: AgentReviewBridge
    plugins: PluginsService
    apps: AppsService
  }
}
