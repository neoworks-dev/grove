import { describe, it, expect } from 'bun:test'
import { RouteRegistry, ApiError } from '../src/main/api/registry'
import { ApiDispatcher } from '../src/main/api/dispatcher'
import type { ClientRecord } from '../src/main/api/clients'
import type { PermissionBroker } from '../src/main/api/broker'
import type { Worktree } from '../src/shared/types'

function testClient(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    key: 'plugin:test.plugin',
    kind: 'plugin',
    id: 'test.plugin',
    name: 'Test Plugin',
    source: 'user',
    declaredScopes: ['workspace.read'],
    ...overrides
  }
}

function fakeBroker(options: { deny?: boolean } = {}): {
  broker: PermissionBroker
  ensured: { permission: string; detail: string }[]
} {
  const ensured: { permission: string; detail: string }[] = []
  const broker = {
    ensure: async (_client: ClientRecord, permission: string, detail: string) => {
      ensured.push({ permission, detail })
      if (options.deny) {
        const error = new Error('denied') as Error & { code: string }
        error.code = 'permission-denied'
        throw error
      }
    }
  } as unknown as PermissionBroker
  return { broker, ensured }
}

const worktree: Worktree = {
  id: 'wt-1',
  path: '/tmp/wt-1',
  branch: 'main'
} as Worktree

function build(options: { deny?: boolean } = {}): {
  registry: RouteRegistry
  dispatcher: ApiDispatcher
  ensured: { permission: string; detail: string }[]
} {
  const registry = new RouteRegistry()
  const { broker, ensured } = fakeBroker(options)
  const dispatcher = new ApiDispatcher({
    registry,
    broker,
    findWorktree: () => worktree
  })
  return { registry, dispatcher, ensured }
}

describe('RouteRegistry', () => {
  it('rejects duplicate method registration', () => {
    const registry = new RouteRegistry()
    registry.register({ method: 'a.b', scope: null, handler: async () => null })
    expect(() =>
      registry.register({ method: 'a.b', scope: null, handler: async () => null })
    ).toThrow('duplicate api route: a.b')
  })

  it('lists registered methods', () => {
    const registry = new RouteRegistry()
    registry.register({ method: 'a.b', scope: null, handler: async () => null })
    registry.register({ method: 'c.d', scope: null, handler: async () => null })
    expect(registry.methods()).toEqual(['a.b', 'c.d'])
  })
})

describe('ApiDispatcher', () => {
  it('rejects unknown methods with the invalid code', async () => {
    const { dispatcher } = build()
    const call = dispatcher.invoke(testClient(), 'c1', 'nope.nothing', {}, { transport: 'worker' })
    await expect(call).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects routes not served on the calling transport', async () => {
    const { registry, dispatcher } = build()
    registry.register({
      method: 'worker.only',
      scope: null,
      transports: ['worker'],
      handler: async () => 'ok'
    })
    const call = dispatcher.invoke(testClient(), 'c1', 'worker.only', {}, { transport: 'socket' })
    await expect(call).rejects.toMatchObject({ code: 'unsupported' })
    const allowed = await dispatcher.invoke(testClient(), 'c2', 'worker.only', {}, { transport: 'worker' })
    expect(allowed).toBe('ok')
  })

  it('ensures the declared scope with the describe detail before the handler', async () => {
    const { registry, dispatcher, ensured } = build()
    let ran = false
    registry.register({
      method: 'gated.route',
      scope: 'workspace.read',
      describe: (args, context) => `read ${context.worktreeFor(args).path}`,
      handler: async () => {
        ran = true
        return null
      }
    })
    await dispatcher.invoke(testClient(), 'c1', 'gated.route', {}, { transport: 'worker' })
    expect(ensured).toEqual([{ permission: 'workspace.read', detail: 'read /tmp/wt-1' }])
    expect(ran).toBe(true)
  })

  it('does not run the handler when the scope is denied', async () => {
    const { registry, dispatcher } = build({ deny: true })
    let ran = false
    registry.register({
      method: 'gated.route',
      scope: 'workspace.read',
      handler: async () => {
        ran = true
        return null
      }
    })
    const call = dispatcher.invoke(testClient(), 'c1', 'gated.route', {}, { transport: 'worker' })
    await expect(call).rejects.toMatchObject({ code: 'permission-denied' })
    expect(ran).toBe(false)
  })

  it('skips the broker entirely for scope-null routes', async () => {
    const { registry, dispatcher, ensured } = build()
    registry.register({ method: 'open.route', scope: null, handler: async () => 'ok' })
    await dispatcher.invoke(testClient(), 'c1', 'open.route', {}, { transport: 'worker' })
    expect(ensured).toEqual([])
  })

  it('streams chunks through emit and resolves at stream end', async () => {
    const { registry, dispatcher } = build()
    registry.register({
      method: 'stream.route',
      scope: null,
      streaming: true,
      handler: async (_args, context) => {
        context.emit([1, 2])
        context.emit([3])
        return null
      }
    })
    const chunks: unknown[] = []
    await dispatcher.invoke(testClient(), 'c1', 'stream.route', {}, {
      transport: 'worker',
      emit: (chunk) => chunks.push(chunk)
    })
    expect(chunks).toEqual([[1, 2], [3]])
  })

  it('cancel aborts the matching call only for the owning client', async () => {
    const { registry, dispatcher } = build()
    registry.register({
      method: 'wait.route',
      scope: null,
      streaming: true,
      handler: (_args, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => resolve('aborted'))
        })
    })
    const call = dispatcher.invoke(testClient(), 'c1', 'wait.route', {}, { transport: 'worker' })
    dispatcher.cancel('plugin:other.plugin', 'c1')
    dispatcher.cancel('plugin:test.plugin', 'c1')
    expect(await call).toBe('aborted')
  })

  it('cancelAllForClient aborts every call of that client', async () => {
    const { registry, dispatcher } = build()
    registry.register({
      method: 'wait.route',
      scope: null,
      streaming: true,
      handler: (_args, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => resolve('aborted'))
        })
    })
    const first = dispatcher.invoke(testClient(), 'c1', 'wait.route', {}, { transport: 'worker' })
    const second = dispatcher.invoke(testClient(), 'c2', 'wait.route', {}, { transport: 'worker' })
    dispatcher.cancelAllForClient('plugin:test.plugin')
    expect(await first).toBe('aborted')
    expect(await second).toBe('aborted')
  })
})

describe('ApiError', () => {
  it('carries the rpc error code', () => {
    const error = new ApiError('nope', 'conflict')
    expect(error.code).toBe('conflict')
    expect(error.message).toBe('nope')
  })
})
