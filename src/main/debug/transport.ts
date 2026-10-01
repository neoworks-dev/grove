// Turning an AdapterLaunch into a live DapConnection: spawn the adapter and
// speak over its stdio, or spawn it as a server and connect, or only connect.
// Child sessions (an adapter's `startDebugging`) reconnect through the same
// launch, which for a server means a second socket to the process already up.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, connect, type Socket } from 'node:net'
import { DapConnection } from './dapConnection'
import type { AdapterLaunch } from './registry'

const CONNECT_ATTEMPTS = 50
const CONNECT_RETRY_MS = 200

/** A connected adapter, and the process behind it when Grove started one. */
export interface AdapterTransport {
  connection: DapConnection
  /** The adapter process this transport spawned; null when it only connected. */
  process: ChildProcess | null
}

export interface TransportOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Where the adapter's own stderr goes: its logging, not the program's output. */
  onAdapterLog: (text: string) => void
}

/** Starts or reaches the adapter a launch describes. */
export async function openTransport(
  launch: AdapterLaunch,
  options: TransportOptions
): Promise<AdapterTransport> {
  if (launch.kind === 'stdio') {
    return spawnStdioAdapter(launch.command, launch.args, options)
  }
  if (launch.kind === 'server') {
    const adapterProcess = spawnAdapter(launch.command, launch.args, options, true)
    try {
      const socket = await connectWithRetry(launch.host, launch.port, adapterProcess)
      return { connection: socketConnection(socket), process: adapterProcess }
    } catch (error) {
      adapterProcess.kill()
      throw error
    }
  }
  const socket = await connectWithRetry(launch.host, launch.port, null)
  return { connection: socketConnection(socket), process: null }
}

/**
 * A second connection for a child session. A server adapter takes one more
 * socket; a stdio adapter can only be spawned again.
 */
export async function openChildTransport(
  launch: AdapterLaunch,
  options: TransportOptions
): Promise<AdapterTransport> {
  if (launch.kind === 'stdio') {
    return spawnStdioAdapter(launch.command, launch.args, options)
  }
  const socket = await connectWithRetry(launch.host, launch.port, null)
  return { connection: socketConnection(socket), process: null }
}

function spawnStdioAdapter(
  command: string,
  args: string[],
  options: TransportOptions
): AdapterTransport {
  const adapterProcess = spawnAdapter(command, args, options, false)
  if (!adapterProcess.stdout || !adapterProcess.stdin) {
    throw new Error(`could not start ${command}: no stdio`)
  }
  const connection = new DapConnection(adapterProcess.stdout, adapterProcess.stdin)
  adapterProcess.on('exit', () => connection.close())
  return { connection, process: adapterProcess }
}

function spawnAdapter(
  command: string,
  args: string[],
  options: TransportOptions,
  logStdout: boolean
): ChildProcess {
  const adapterProcess = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  adapterProcess.stderr?.on('data', (chunk: Buffer) => options.onAdapterLog(chunk.toString()))
  if (logStdout) {
    adapterProcess.stdout?.on('data', (chunk: Buffer) => options.onAdapterLog(chunk.toString()))
  }
  adapterProcess.on('error', (error) => options.onAdapterLog(`${command}: ${error.message}\n`))
  return adapterProcess
}

function socketConnection(socket: Socket): DapConnection {
  const connection = new DapConnection(socket, socket)
  connection.onClose(() => socket.destroy())
  return connection
}

/**
 * Connects to a server adapter, retrying while it starts listening. Gives up
 * early when the process it waits on has already exited.
 */
async function connectWithRetry(
  host: string,
  port: number,
  adapterProcess: ChildProcess | null
): Promise<Socket> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
    if (adapterProcess && adapterProcess.exitCode !== null) {
      throw new Error(`debug adapter exited with code ${adapterProcess.exitCode} before listening`)
    }
    try {
      return await connectOnce(host, port)
    } catch (error) {
      lastError = error as Error
      await delay(CONNECT_RETRY_MS)
    }
  }
  throw new Error(
    `could not connect to the debug adapter on ${host}:${port}: ${lastError?.message}`
  )
}

function connectOnce(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** A TCP port nothing is listening on right now, for a server adapter to take. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
          return
        }
        reject(new Error('could not find a free port'))
      })
    })
  })
}
