// Transport-agnostic route registry for the shared API layer. Route modules
// self-register handlers keyed by dotted method name ('workspace.readFile');
// each declares the permission scope the dispatcher must ensure, whether it
// streams, and which transports serve it. Handlers receive a context object
// and never touch Electron/IPC directly.
//
// Mutation routes follow the optimistic-concurrency convention: params carry
// an optional expectedVersion, reads return a version, and a mismatch throws
// ApiError('conflict') — versions themselves are domain semantics.

import type { Worktree } from '../../shared/types'
import type { PluginPermission, RpcError } from '../../shared/plugins'
import type { ClientRecord } from './clients'
import type { PermissionBroker } from './broker'

export type ApiTransport = 'worker' | 'socket'

export class ApiError extends Error {
  code: RpcError['code']

  constructor(message: string, code: RpcError['code']) {
    super(message)
    this.code = code
  }
}

export interface RouteContext {
  client: ClientRecord
  callId: string
  broker: PermissionBroker
  // No-op for non-streaming routes.
  emit: (chunk: unknown) => void
  // Fires on explicit cancel, client death, or transport disconnect.
  signal: AbortSignal
  worktreeFor: (params: Record<string, unknown>) => Worktree
}

export interface RouteDefinition {
  method: string
  // Ensured by the dispatcher before the handler runs. null = the handler
  // does its own checking (path-scoped ensurePath, or a bridge that prompts
  // with richer detail) — never "ungated" unless the route is public metadata.
  scope: PluginPermission | null
  streaming?: boolean
  // Default: served on both transports.
  transports?: ApiTransport[]
  // Human-readable prompt detail for the dispatcher's scope check.
  describe?: (params: Record<string, unknown>, context: RouteContext) => string
  handler: (params: Record<string, unknown>, context: RouteContext) => Promise<unknown>
}

export class RouteRegistry {
  private routes = new Map<string, RouteDefinition>()

  register(route: RouteDefinition): void {
    if (this.routes.has(route.method)) {
      throw new Error(`duplicate api route: ${route.method}`)
    }
    this.routes.set(route.method, route)
  }

  get(method: string): RouteDefinition | null {
    return this.routes.get(method) ?? null
  }

  methods(): string[] {
    return [...this.routes.keys()]
  }
}
