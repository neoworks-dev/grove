import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { connect, type Socket } from 'net'
import { ApiSocketServer } from '../src/main/api/socket/server'
import { AppPairing } from '../src/main/api/socket/pairing'
import { ApiDispatcher } from '../src/main/api/dispatcher'
import { RouteRegistry } from '../src/main/api/registry'
import type { PermissionBroker } from '../src/main/api/broker'
import { RpcEndpoint } from '../src/shared/rpc'
import { FrameDecoder, encodeFrame } from '../sdk/src/frames'
import type { RpcMessage, HelloResult } from '../src/shared/plugins'
import type { Worktree } from '../src/shared/types'

const onWindows = process.platform === 'win32'
const maybe = onWindows ? describe.skip : describe

let dir: string
let server: ApiSocketServer
let socketPath: string
let openSockets: Socket[]

function buildServer(): ApiSocketServer {
  const registry = new RouteRegistry()
  registry.register({
    method: 'echo.run',
    scope: null,
    handler: async (args) => ({ echoed: args })
  })
  registry.register({
    method: 'echo.stream',
    scope: null,
    streaming: true,
    handler: async (args, context) => {
      context.emit([1, 2])
      context.emit([3])
      return null
    }
  })
  registry.register({
    method: 'echo.hang',
    scope: null,
    streaming: true,
    handler: (_args, context) =>
      new Promise((resolve) => context.signal.addEventListener('abort', () => resolve(null)))
  })
  registry.register({
    method: 'worker.only',
    scope: null,
    transports: ['worker'],
    handler: async () => 'nope'
  })
  const broker = { ensure: async () => {} } as unknown as PermissionBroker
  const dispatcher = new ApiDispatcher({
    registry,
    broker,
    findWorktree: () => ({ id: 'wt', path: '/tmp', branch: 'main' }) as Worktree
  })
  const pairing = new AppPairing(
    {
      onPairingRequest: (request) => queueMicrotask(() => pairing.respondPairing(request.id, true))
    },
    { storePath: join(dir, 'external-apps.json') }
  )
  return new ApiSocketServer({ dispatcher, pairing, socketPath, discoveryPath: null })
}

async function client(): Promise<RpcEndpoint> {
  const socket = connect(socketPath)
  openSockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const decoder = new FrameDecoder()
  const endpoint = new RpcEndpoint((message: RpcMessage) => {
    socket.write(encodeFrame(message))
  }, 'odd')
  socket.on('data', (data) => {
    for (const message of decoder.push(data)) endpoint.handleMessage(message)
  })
  return endpoint
}

async function pairedClient(scopes: string[] = ['workspace.read']): Promise<{
  endpoint: RpcEndpoint
  helloResult: HelloResult
}> {
  const endpoint = await client()
  const helloResult = (await endpoint.request('api.hello', {
    appId: 'test-app',
    name: 'Test App',
    version: '1.0.0',
    requestedScopes: scopes
  })) as HelloResult
  return { endpoint, helloResult }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grove-socket-'))
  socketPath = join(dir, 'grove.sock')
  openSockets = []
  server = buildServer()
  await server.listen()
})

afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

maybe('ApiSocketServer', () => {
  it('refuses dispatch before hello', async () => {
    const endpoint = await client()
    await expect(endpoint.request('echo.run', {})).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })

  it('pairs via hello and dispatches request/response', async () => {
    const { endpoint, helloResult } = await pairedClient()
    expect(helloResult.token).toBeDefined()
    const result = await endpoint.request('echo.run', { x: 1 })
    expect(result).toEqual({ echoed: { x: 1 } })
  })

  it('reconnects with the minted token without a new prompt', async () => {
    const first = await pairedClient()
    const second = await client()
    const result = (await second.request('api.hello', {
      appId: 'test-app',
      name: 'Test App',
      version: '1.0.0',
      requestedScopes: ['workspace.read'],
      token: first.helloResult.token
    })) as HelloResult
    expect(result.token).toBeUndefined()
    expect(await second.request('echo.run', { y: 2 })).toEqual({ echoed: { y: 2 } })
  })

  it('streams chunks and ends', async () => {
    const { endpoint } = await pairedClient()
    const chunks: unknown[] = []
    const handle = endpoint.requestStream('echo.stream', {}, (chunk) => chunks.push(chunk))
    await handle.done
    expect(chunks).toEqual([[1, 2], [3]])
  })

  it('rejects worker-only routes with unsupported', async () => {
    const { endpoint } = await pairedClient()
    await expect(endpoint.request('worker.only', {})).rejects.toMatchObject({
      code: 'unsupported'
    })
  })

  it('cancel aborts an in-flight stream', async () => {
    const { endpoint } = await pairedClient()
    const handle = endpoint.requestStream('echo.hang', {}, () => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    handle.cancel()
    await expect(handle.done).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('rejects even request ids', async () => {
    const endpoint = await client()
    const evil = new Promise((resolve) => {
      // Bypass the endpoint to send a raw even-id request.
      openSockets[openSockets.length - 1].write(
        encodeFrame({ kind: 'request', id: 2, method: 'echo.run', params: {} })
      )
      const decoder = new FrameDecoder()
      openSockets[openSockets.length - 1].on('data', (data) => {
        for (const message of decoder.push(data)) {
          if (message.kind === 'response' && message.id === 2) resolve(message)
        }
      })
    })
    const response = (await evil) as { error?: { code?: string } }
    expect(response.error?.code).toBe('invalid')
    void endpoint
  })

  it('takes over a stale socket file', async () => {
    // Simulate a crash: close the server without removing state, then listen
    // again on the same path with a fresh server.
    await server.close()
    const replacement = buildServer()
    await replacement.listen()
    const endpoint = await client()
    const result = (await endpoint.request('api.hello', {
      appId: 'test-app',
      name: 'Test App',
      version: '1.0.0',
      requestedScopes: []
    })) as HelloResult
    expect(result.grantedScopes).toEqual([])
    await replacement.close()
    server = buildServer()
    await server.listen()
  })
})
