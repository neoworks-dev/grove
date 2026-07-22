// services.* routes: observe and control per-worktree dev services. Log
// streaming reads the service's log file; with follow=true it tails the file
// until the caller cancels.

import { open, stat } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'
import type { ServiceRuntime } from '../../../shared/types'
import { ApiError, type RouteRegistry } from '../registry'

export interface ServicesRouteDeps {
  listServices: (worktreeId: string) => ServiceRuntime[] | Promise<ServiceRuntime[]>
  startService: (worktreeId: string, name: string) => Promise<unknown>
  stopService: (worktreeId: string, name: string) => Promise<unknown>
}

// serviceId over the wire is '<worktreeId>:<name>' — services are keyed per
// worktree by config name.
function parseServiceId(raw: unknown): { worktreeId: string; name: string } {
  const serviceId = String(raw ?? '')
  const separator = serviceId.lastIndexOf(':')
  if (separator <= 0 || separator === serviceId.length - 1) {
    throw new ApiError('serviceId must be "<worktreeId>:<name>"', 'invalid')
  }
  return { worktreeId: serviceId.slice(0, separator), name: serviceId.slice(separator + 1) }
}

export function registerServicesRoutes(registry: RouteRegistry, deps: ServicesRouteDeps): void {
  registry.register({
    method: 'services.list',
    scope: 'services.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const runtimes = await deps.listServices(worktree.id)
      return runtimes.map((runtime) => ({
        serviceId: `${runtime.worktreeId}:${runtime.name}`,
        worktreeId: runtime.worktreeId,
        name: runtime.name,
        status: runtime.status,
        ports: runtime.ports
      }))
    }
  })

  registry.register({
    method: 'services.readLogs',
    scope: 'services.read',
    streaming: true,
    handler: async (args, context) => {
      const { worktreeId, name } = parseServiceId(args.serviceId)
      const runtimes = await deps.listServices(worktreeId)
      const runtime = runtimes.find((entry) => entry.name === name)
      if (!runtime) throw new ApiError(`unknown service: ${name}`, 'invalid')
      const follow = args.follow === true
      await streamLogFile(runtime.logPath, follow, context.emit, context.signal)
      return null
    }
  })

  registry.register({
    method: 'services.start',
    scope: 'services.manage',
    handler: async (args) => {
      const { worktreeId, name } = parseServiceId(args.serviceId)
      await deps.startService(worktreeId, name)
    }
  })

  registry.register({
    method: 'services.stop',
    scope: 'services.manage',
    handler: async (args) => {
      const { worktreeId, name } = parseServiceId(args.serviceId)
      await deps.stopService(worktreeId, name)
    }
  })
}

async function streamLogFile(
  logPath: string,
  follow: boolean,
  emit: (chunk: unknown) => void,
  signal: AbortSignal
): Promise<void> {
  let offset = 0
  const emitFrom = async (): Promise<void> => {
    const info = await stat(logPath).catch(() => null)
    if (!info) return
    if (info.size < offset) offset = 0 // rotated/truncated
    if (info.size === offset) return
    const handle = await open(logPath, 'r')
    try {
      const length = info.size - offset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      offset = info.size
      const lines = buffer
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0)
      if (lines.length > 0) emit(lines.map((line) => ({ line })))
    } finally {
      await handle.close()
    }
  }

  await emitFrom()
  if (!follow || signal.aborted) return

  await new Promise<void>((resolve) => {
    let watcher: FSWatcher | null = null
    try {
      watcher = watch(logPath, () => void emitFrom())
    } catch {
      resolve()
      return
    }
    signal.addEventListener('abort', () => {
      watcher?.close()
      resolve()
    })
  })
}
