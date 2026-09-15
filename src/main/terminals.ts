// Integrated terminal frontend: grove's half of the terminal daemon.
//
// The shells themselves run in a detached process (see terminals/daemon.ts), so
// quitting grove no longer kills what is running in them. This keeps the API the
// rest of the app was written against — create, write, resize, kill — and adds
// the two calls that only make sense once a terminal can outlive the window:
// `list`, for the terminals still running, and `attach`, which takes one over
// and hands back what it printed in the meantime.
//
// Commands are queued while the daemon is being started, so callers never have
// to know whether it was already up: `create` picks the id itself and returns it
// straight away.

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  encode,
  LineDecoder,
  type ClientMessage,
  type DaemonMessage,
  type TerminalSessionInfo
} from './terminals/protocol'

export type { TerminalSessionInfo } from './terminals/protocol'

export interface TerminalEvents {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
  // Foreground process name (e.g. 'zsh', 'vim', 'node'), emitted on change.
  onTitle: (id: string, title: string) => void
}

export interface CreateTerminalOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  cols?: number
  rows?: number
  /** Which worktree the terminal belongs to, so panes restore their own. */
  worktreeId?: string | null
}

// How long a request to the daemon may take before the caller is given an empty
// answer. Everything it replies to is served out of memory, so this only ever
// fires when the daemon is wedged or gone.
const REQUEST_TIMEOUT_MS = 2_000

// A freshly spawned daemon needs a moment to bind its socket.
const CONNECT_RETRY_MS = 50
const CONNECT_TIMEOUT_MS = 5_000

export interface TerminalManagerOptions {
  /** Where the daemon listens. One socket per grove installation. */
  socketPath: string
  /** The daemon entry point, spawned when nothing is listening yet. */
  daemonScript?: string
}

export class TerminalManager {
  private socket: Socket | null = null
  private connecting: Promise<Socket | null> | null = null
  private queue: ClientMessage[] = []
  private pending = new Map<string, (message: DaemonMessage) => void>()
  private decoder = new LineDecoder()
  private disposed = false

  constructor(
    private events: TerminalEvents,
    private options: TerminalManagerOptions
  ) {}

  // ── Commands ────────────────────────────────────────────────────

  /**
   * Open a terminal. The id is grove's to choose, which is what lets this stay
   * synchronous while the daemon is still starting up.
   */
  create(options: CreateTerminalOptions): string {
    const id = `term-${randomUUID()}`
    this.send({
      type: 'create',
      id,
      cwd: options.cwd,
      env: stringEnv(options.env),
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      worktreeId: options.worktreeId ?? null
    })
    return id
  }

  write(id: string, data: string): void {
    this.send({ type: 'write', id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ type: 'resize', id, cols: Math.max(1, cols), rows: Math.max(1, rows) })
  }

  kill(id: string): void {
    this.send({ type: 'kill', id })
  }

  /** The terminals still running, including those a previous grove started. */
  async list(): Promise<TerminalSessionInfo[]> {
    const reply = await this.request((requestId) => ({ type: 'list', requestId }))
    if (!reply || reply.type !== 'sessions') return []
    return reply.sessions
  }

  /**
   * Take over a terminal and get back what it printed while grove was away, so
   * the view can be redrawn rather than starting blank.
   */
  async attach(id: string, cols: number, rows: number): Promise<string> {
    const reply = await this.request((requestId) => ({
      type: 'attach',
      requestId,
      id,
      cols: Math.max(1, cols),
      rows: Math.max(1, rows)
    }))
    if (!reply || reply.type !== 'attached') return ''
    return reply.scrollback
  }

  /**
   * Let go of the daemon without touching the shells.
   *
   * This is what shutdown calls: the whole point of the daemon is that a build
   * or an editor running in a terminal survives grove closing.
   */
  detach(): void {
    this.disposed = true
    for (const resolve of this.pending.values())
      resolve({ type: 'sessions', requestId: '', sessions: [] })
    this.pending.clear()
    this.socket?.destroy()
    this.socket = null
  }

  // ── Transport ───────────────────────────────────────────────────

  private send(message: ClientMessage): void {
    if (this.disposed) return
    if (this.socket) {
      this.socket.write(encode(message))
      return
    }
    this.queue.push(message)
    void this.ensureConnected()
  }

  private async request(
    build: (requestId: string) => ClientMessage
  ): Promise<DaemonMessage | null> {
    if (this.disposed) return null
    const requestId = randomUUID()
    const answer = new Promise<DaemonMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(null)
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, (message) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(message)
      })
    })
    this.send(build(requestId))
    return answer
  }

  /** Connect, starting the daemon when nothing is listening yet. */
  private ensureConnected(): Promise<Socket | null> {
    if (this.socket) return Promise.resolve(this.socket)
    if (this.connecting) return this.connecting

    this.connecting = this.openSocket().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async openSocket(): Promise<Socket | null> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    let spawned = false

    while (!this.disposed && Date.now() < deadline) {
      const socket = await tryConnect(this.options.socketPath)
      if (socket) {
        this.adopt(socket)
        return socket
      }
      if (!spawned) {
        this.spawnDaemon()
        spawned = true
      }
      await delay(CONNECT_RETRY_MS)
    }
    console.error('[terminals] could not reach the terminal daemon')
    return null
  }

  private adopt(socket: Socket): void {
    this.socket = socket
    this.decoder = new LineDecoder()
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      for (const message of this.decoder.push(chunk)) this.dispatch(message as DaemonMessage)
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
    })

    const queued = this.queue
    this.queue = []
    for (const message of queued) socket.write(encode(message))
  }

  private dispatch(message: DaemonMessage): void {
    if (message.type === 'data') {
      this.events.onData(message.id, message.data)
      return
    }
    if (message.type === 'exit') {
      this.events.onExit(message.id, message.exitCode)
      return
    }
    if (message.type === 'title') {
      this.events.onTitle(message.id, message.title)
      return
    }
    this.pending.get(message.requestId)?.(message)
  }

  /**
   * Start the daemon, detached and with its own session, so it is not part of
   * the process group the OS tears down when grove exits.
   */
  private spawnDaemon(): void {
    const script = this.options.daemonScript ?? join(__dirname, 'terminalDaemon.js')
    const child = spawn(process.execPath, [script, this.options.socketPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    child.on('error', (cause) => console.error('[terminals] daemon failed to start:', cause))
    child.unref()
  }
}

/** One connection attempt; null when nothing is listening on the socket yet. */
function tryConnect(socketPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    const fail = (): void => {
      socket.destroy()
      resolve(null)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.removeListener('error', fail)
      resolve(socket)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The daemon takes a plain string map; unset variables are simply not sent. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    result[key] = value
  }
  return result
}
