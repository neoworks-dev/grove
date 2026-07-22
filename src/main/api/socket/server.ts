// Local socket transport for external apps: a unix domain socket (named pipe
// on Windows) speaking ndjson-framed RpcMessages through the same RpcEndpoint
// used at the worker boundary. Strict hello-first: nothing dispatches until
// api.hello establishes a ClientRecord, and on Windows — where the pipe is
// reachable by every local process — the bearer token is the only boundary,
// so the deadline and the pre-auth refusal are load-bearing.

import { createServer, connect, type Server, type Socket } from 'net'
import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { FrameDecoder, FrameError, encodeFrame } from '../../../../sdk/src/frames'
import { GROVE_API_VERSION, type HelloParams, type RpcMessage } from '../../../shared/plugins'
import { RpcEndpoint } from '../../../shared/rpc'
import type { ClientRecord } from '../clients'
import type { ApiDispatcher } from '../dispatcher'
import { ApiError } from '../registry'
import type { AppPairing } from './pairing'

const HELLO_DEADLINE_MS = 5_000
// Destroy connections whose outbound buffer balloons (slow reader during a
// stream); crude but safe — the client sees a socket error and reconnects.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024

interface SocketServerDeps {
  dispatcher: ApiDispatcher
  pairing: AppPairing
  socketPath: string
  // Discovery file advertising the socket to clients; skipped when null.
  discoveryPath: string | null
  log?: (message: string) => void
}

interface Connection {
  socket: Socket
  client: ClientRecord | null
  callIds: Set<string>
}

export class ApiSocketServer {
  private deps: SocketServerDeps
  private server: Server | null = null
  private connections = new Set<Connection>()
  private connectionCounter = 0

  constructor(deps: SocketServerDeps) {
    this.deps = deps
  }

  async listen(): Promise<string> {
    const path = this.deps.socketPath
    if (!isWindowsPipe(path)) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await removeStaleSocket(path)
    }
    this.server = createServer((socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(path, () => resolve())
    })
    if (this.deps.discoveryPath) {
      await writeFile(
        this.deps.discoveryPath,
        JSON.stringify({ socketPath: path, apiVersion: GROVE_API_VERSION, pid: process.pid }),
        'utf8'
      )
    }
    return path
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.socket.destroy()
    this.connections.clear()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (this.deps.discoveryPath) {
      await rm(this.deps.discoveryPath, { force: true }).catch(() => {})
    }
    if (!isWindowsPipe(this.deps.socketPath)) {
      await rm(this.deps.socketPath, { force: true }).catch(() => {})
    }
  }

  // Kick every live connection of a client (unpair/revoke).
  dropClient(clientKey: string): void {
    for (const connection of this.connections) {
      if (connection.client?.key === clientKey) connection.socket.destroy()
    }
  }

  private handleConnection(socket: Socket): void {
    this.connectionCounter += 1
    const connectionId = this.connectionCounter
    const connection: Connection = { socket, client: null, callIds: new Set() }
    this.connections.add(connection)
    let callCounter = 0
    const decoder = new FrameDecoder()
    const endpoint = new RpcEndpoint((message: RpcMessage) => {
      socket.write(encodeFrame(message))
      if (socket.writableLength > MAX_BUFFERED_BYTES) {
        this.deps.log?.(`api socket: dropping slow client (buffer overflow)`)
        socket.destroy()
      }
    }, 'even')

    const helloTimer = setTimeout(() => {
      if (connection.client) return
      this.deps.log?.('api socket: no hello within deadline, closing')
      socket.destroy()
    }, HELLO_DEADLINE_MS)

    endpoint.setFallbackHandler(async (method, params, context) => {
      if (method === 'api.hello') {
        const { client, result } = await this.deps.pairing.hello(params as HelloParams)
        connection.client = client
        return result
      }
      const client = connection.client
      if (!client) {
        throw new ApiError('api.hello must be the first request', 'unauthenticated')
      }
      callCounter += 1
      const callId = `${client.key}:${connectionId}:${callCounter}`
      connection.callIds.add(callId)
      context.token.onCancel(() => this.deps.dispatcher.cancel(client.key, callId))
      try {
        return await this.deps.dispatcher.invoke(client, callId, method, params, {
          transport: 'socket',
          emit: context.emit
        })
      } finally {
        connection.callIds.delete(callId)
      }
    })

    socket.on('data', (data) => {
      let messages: RpcMessage[]
      try {
        messages = decoder.push(data)
      } catch (error) {
        if (error instanceof FrameError) {
          this.deps.log?.(`api socket: ${error.message}, closing connection`)
          socket.destroy()
          return
        }
        throw error
      }
      for (const message of messages) {
        // Clients own odd ids; a request with an even id would collide with
        // the server's own outbound ids.
        if (message.kind === 'request' && message.id % 2 === 0) {
          socket.write(
            encodeFrame({
              kind: 'response',
              id: message.id,
              error: { message: 'clients must use odd request ids', code: 'invalid' }
            })
          )
          continue
        }
        endpoint.handleMessage(message)
      }
    })

    const cleanup = (): void => {
      clearTimeout(helloTimer)
      this.connections.delete(connection)
      const client = connection.client
      if (!client) return
      for (const callId of connection.callIds) {
        this.deps.dispatcher.cancel(client.key, callId)
      }
      connection.callIds.clear()
    }
    socket.on('close', cleanup)
    socket.on('error', () => socket.destroy())
  }
}

export function isWindowsPipe(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\')
}

// A leftover socket file from a crashed instance would block listen(); probe
// it and unlink only if nothing answers.
async function removeStaleSocket(path: string): Promise<void> {
  const alive = await new Promise<boolean>((resolve) => {
    const probe = connect(path)
    const done = (result: boolean): void => {
      probe.destroy()
      resolve(result)
    }
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
    setTimeout(() => done(false), 500)
  })
  if (alive) {
    throw new Error(`another Grove instance is already serving ${path}`)
  }
  await rm(path, { force: true }).catch(() => {})
}
