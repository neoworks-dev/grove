// The terminal daemon: the process that actually owns the shells.
//
// grove used to spawn its ptys itself, which meant quitting the app killed
// whatever was running in them — a long build, a lazygit session, an ssh login.
// Here they belong to a process that outlives grove: the app connects as a
// client, streams input and output over a socket, and on the next start finds
// the same shells still running and replays their scrollback into xterm.
//
// The daemon is deliberately dumb. It knows nothing about worktrees or panes; it
// keeps a `worktreeId` string for each session only so grove can sort them back
// into the panes they came from.

import { chmodSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { spawn as spawnPty, type IPty } from 'node-pty'
import {
  encode,
  LineDecoder,
  type ClientMessage,
  type DaemonMessage,
  type TerminalSessionInfo
} from './protocol'
import { listenPastStaleSocket, removeSocket } from './listen'
import { Scrollback } from './scrollback'

// node-pty has no change event for the foreground process on POSIX, so it is
// sampled. Same cadence grove used when it owned the ptys itself.
const TITLE_POLL_MS = 1000

// With no shells left and nobody connected there is nothing to outlive, so the
// daemon stands down rather than lingering until the machine reboots. The grace
// period covers a grove restart, which disconnects and reconnects.
const IDLE_EXIT_MS = 30_000

interface Session {
  id: string
  pty: IPty
  info: TerminalSessionInfo
  scrollback: Scrollback
  titlePoll: ReturnType<typeof setInterval>
}

class TerminalDaemon {
  private sessions = new Map<string, Session>()
  private clients = new Set<Socket>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private server: Server | null = null

  constructor(private socketPath: string) {}

  listen(): void {
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    void this.bind(server)
  }

  /**
   * Take the socket, unless a daemon is already answering on it.
   *
   * The path being in use is not the same as being served — a killed daemon
   * leaves its socket file behind — so `listenPastStaleSocket` connects before
   * deciding, and only 'taken' means grove has a daemon without this one.
   */
  private async bind(server: Server): Promise<void> {
    const outcome = await listenPastStaleSocket(server, this.socketPath)
    if (outcome === 'taken') process.exit(0)
    server.on('error', (cause) => {
      throw cause
    })
    this.onListening()
  }

  private onListening(): void {
    restrictToOwner(this.socketPath)
    this.scheduleIdleExit()
  }

  // ── Clients ─────────────────────────────────────────────────────

  private accept(socket: Socket): void {
    this.clients.add(socket)
    this.cancelIdleExit()

    const decoder = new LineDecoder()
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      for (const message of decoder.push(chunk)) this.handle(socket, message as ClientMessage)
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      this.clients.delete(socket)
      this.scheduleIdleExit()
    })
  }

  private handle(socket: Socket, message: ClientMessage): void {
    if (message.type === 'create') {
      this.create(message)
      return
    }
    if (message.type === 'write') {
      this.sessions.get(message.id)?.pty.write(message.data)
      return
    }
    if (message.type === 'resize') {
      this.resize(message.id, message.cols, message.rows)
      return
    }
    if (message.type === 'kill') {
      this.kill(message.id)
      return
    }
    if (message.type === 'list') {
      const sessions = [...this.sessions.values()].map((session) => session.info)
      send(socket, { type: 'sessions', requestId: message.requestId, sessions })
      return
    }
    if (message.type === 'attach') this.attach(socket, message)
  }

  // ── Sessions ────────────────────────────────────────────────────

  private create(message: Extract<ClientMessage, { type: 'create' }>): void {
    if (this.sessions.has(message.id)) return

    const pty = spawnPty(shellOf(message.env), shellArgs(), {
      name: 'xterm-256color',
      cwd: message.cwd,
      cols: Math.max(1, message.cols),
      rows: Math.max(1, message.rows),
      env: { ...message.env, TERM: 'xterm-256color' } as Record<string, string>
    })

    const session: Session = {
      id: message.id,
      pty,
      info: {
        id: message.id,
        title: pty.process || 'shell',
        cwd: message.cwd,
        worktreeId: message.worktreeId,
        cols: message.cols,
        rows: message.rows,
        startedAt: Date.now()
      },
      scrollback: new Scrollback(),
      titlePoll: setInterval(() => this.sampleTitle(message.id), TITLE_POLL_MS)
    }
    this.sessions.set(message.id, session)
    this.cancelIdleExit()

    pty.onData((data) => {
      session.scrollback.append(data)
      this.broadcast({ type: 'data', id: session.id, data })
    })
    pty.onExit(({ exitCode }) => {
      this.forget(session.id)
      this.broadcast({ type: 'exit', id: session.id, exitCode })
    })
  }

  /**
   * Hand a reconnecting grove everything it needs to redraw the terminal: the
   * output it missed, and the size of the window it is being shown in now.
   */
  private attach(socket: Socket, message: Extract<ClientMessage, { type: 'attach' }>): void {
    const session = this.sessions.get(message.id)
    if (!session) {
      send(socket, {
        type: 'attached',
        requestId: message.requestId,
        id: message.id,
        scrollback: ''
      })
      return
    }
    send(socket, {
      type: 'attached',
      requestId: message.requestId,
      id: message.id,
      scrollback: session.scrollback.text()
    })
    this.resize(message.id, message.cols, message.rows)
  }

  private resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.info.cols = Math.max(1, cols)
    session.info.rows = Math.max(1, rows)
    try {
      session.pty.resize(session.info.cols, session.info.rows)
    } catch {
      // The pty went away between the ask and the resize.
    }
  }

  private kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.forget(id)
    try {
      session.pty.kill()
    } catch {
      // Already dead.
    }
  }

  private forget(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    clearInterval(session.titlePoll)
    this.sessions.delete(id)
    this.scheduleIdleExit()
  }

  private sampleTitle(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    const title = session.pty.process
    if (!title || title === session.info.title) return
    session.info.title = title
    this.broadcast({ type: 'title', id, title })
  }

  private broadcast(message: DaemonMessage): void {
    for (const client of this.clients) send(client, message)
  }

  // ── Lifetime ────────────────────────────────────────────────────

  private scheduleIdleExit(): void {
    if (this.sessions.size > 0 || this.clients.size > 0) return
    if (this.idleTimer) return
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_EXIT_MS)
  }

  private cancelIdleExit(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private shutdown(): void {
    if (this.sessions.size > 0 || this.clients.size > 0) {
      this.idleTimer = null
      this.scheduleIdleExit()
      return
    }
    this.server?.close()
    removeSocket(this.socketPath)
    process.exit(0)
  }
}

function send(socket: Socket, message: DaemonMessage): void {
  if (socket.destroyed) return
  socket.write(encode(message))
}

/**
 * The shell to run. grove passes the environment the worktree's services see,
 * so the user's `SHELL` comes from there rather than from the daemon's own
 * environment, which is whatever grove was started from.
 */
function shellOf(env: Record<string, string>): string {
  if (process.platform === 'win32') return env.COMSPEC || process.env.COMSPEC || 'powershell.exe'
  return env.SHELL || process.env.SHELL || '/bin/bash'
}

function shellArgs(): string[] {
  if (process.platform === 'win32') return []
  return ['-l', '-i']
}

/** The socket carries shell input; nobody else on the machine gets to write to it. */
function restrictToOwner(socketPath: string): void {
  if (process.platform === 'win32') return
  try {
    chmodSync(socketPath, 0o600)
  } catch {
    // A socket that cannot be chmod'ed is still ours; the directory it sits in
    // is the user's own app-data directory.
  }
}

/** Start the daemon on a socket path. The process stays up on its own after this. */
export function startTerminalDaemon(socketPath: string): void {
  if (!socketPath) throw new Error('the terminal daemon needs a socket path')
  new TerminalDaemon(socketPath).listen()
}
