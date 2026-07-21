// ApiDispatcher: the single invoke path for every API client on every
// transport. Looks up the route, enforces transport availability and the
// declared permission scope, then runs the handler with a per-call
// AbortSignal so individual calls (and all of a client's calls when it dies
// or disconnects) can be cancelled.

import type { Worktree } from '../../shared/types'
import type { ClientRecord } from './clients'
import type { PermissionBroker } from './broker'
import { ApiError, RouteRegistry, type ApiTransport, type RouteContext } from './registry'

interface DispatcherDeps {
  registry: RouteRegistry
  broker: PermissionBroker
  findWorktree: (worktreeId: string) => Worktree
}

interface ActiveCall {
  clientKey: string
  controller: AbortController
}

export interface InvokeOptions {
  transport: ApiTransport
  emit?: (chunk: unknown) => void
}

export class ApiDispatcher {
  private deps: DispatcherDeps
  private active = new Map<string, ActiveCall>()

  constructor(deps: DispatcherDeps) {
    this.deps = deps
  }

  async invoke(
    client: ClientRecord,
    callId: string,
    method: string,
    params: unknown,
    options: InvokeOptions
  ): Promise<unknown> {
    const route = this.deps.registry.get(method)
    if (!route) throw new ApiError(`unknown api method: ${method}`, 'invalid')
    const transports = route.transports ?? ['worker', 'socket']
    if (!transports.includes(options.transport)) {
      throw new ApiError(`${method} is not available over the ${options.transport} transport`, 'unsupported')
    }
    const controller = new AbortController()
    this.active.set(callId, { clientKey: client.key, controller })
    const context: RouteContext = {
      client,
      callId,
      broker: this.deps.broker,
      emit: options.emit ?? (() => {}),
      signal: controller.signal,
      worktreeFor: (args) => this.deps.findWorktree(String(args.worktreeId ?? ''))
    }
    try {
      const args = (params ?? {}) as Record<string, unknown>
      if (route.scope) {
        const detail = route.describe ? route.describe(args, context) : method
        await this.deps.broker.ensure(client, route.scope, detail)
      }
      return await route.handler(args, context)
    } finally {
      this.active.delete(callId)
    }
  }

  cancel(clientKey: string, callId: string): void {
    const call = this.active.get(callId)
    if (!call || call.clientKey !== clientKey) return
    call.controller.abort()
    this.active.delete(callId)
  }

  cancelAllForClient(clientKey: string): void {
    for (const [callId, call] of this.active) {
      if (call.clientKey !== clientKey) continue
      call.controller.abort()
      this.active.delete(callId)
    }
  }
}
