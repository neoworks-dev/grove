// Integrated terminal backend. Each session is a pseudo-terminal (node-pty)
// running the user's shell; the renderer's xterm view streams to/from it over
// IPC. Sessions are tracked so they can be resized, killed, and cleaned up on
// shutdown.

import { spawn as spawnPty, type IPty } from 'node-pty'

export interface TerminalEvents {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
  // Foreground process name (e.g. 'zsh', 'vim', 'node'), emitted on change.
  onTitle: (id: string, title: string) => void
}

// How often to sample the pty's foreground process name.
const TITLE_POLL_MS = 1000

export interface CreateTerminalOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  cols?: number
  rows?: number
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

export class TerminalManager {
  private sessions = new Map<string, IPty>()
  private titlePolls = new Map<string, ReturnType<typeof setInterval>>()
  private lastTitles = new Map<string, string>()
  private counter = 0

  constructor(private events: TerminalEvents) {}

  create(options: CreateTerminalOptions): string {
    this.counter += 1
    const id = `term-${this.counter}`
    const pty = spawnPty(defaultShell(), [], {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      env: { ...options.env, TERM: 'xterm-256color' } as Record<string, string>
    })
    pty.onData((data) => this.events.onData(id, data))
    pty.onExit(({ exitCode }) => {
      this.stopTitlePoll(id)
      this.sessions.delete(id)
      this.events.onExit(id, exitCode)
    })
    this.sessions.set(id, pty)
    this.startTitlePoll(id, pty)
    return id
  }

  // node-pty exposes the pty's foreground process name via `.process`. There is
  // no change event on POSIX, so sample it and emit only when it changes.
  private startTitlePoll(id: string, pty: IPty): void {
    const sample = (): void => {
      const title = pty.process
      if (!title || this.lastTitles.get(id) === title) return
      this.lastTitles.set(id, title)
      this.events.onTitle(id, title)
    }
    sample()
    this.titlePolls.set(id, setInterval(sample, TITLE_POLL_MS))
  }

  private stopTitlePoll(id: string): void {
    const timer = this.titlePolls.get(id)
    if (timer) clearInterval(timer)
    this.titlePolls.delete(id)
    this.lastTitles.delete(id)
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const pty = this.sessions.get(id)
    if (!pty) return
    try {
      pty.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      // pty already gone
    }
  }

  kill(id: string): void {
    const pty = this.sessions.get(id)
    if (!pty) return
    this.stopTitlePoll(id)
    this.sessions.delete(id)
    try {
      pty.kill()
    } catch {
      // already dead
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}
