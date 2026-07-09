// Integrated terminal backend. Each session is a pseudo-terminal (node-pty)
// running the user's shell; the renderer's xterm view streams to/from it over
// IPC. Sessions are tracked so they can be resized, killed, and cleaned up on
// shutdown.

import { spawn as spawnPty, type IPty } from 'node-pty'

export interface TerminalEvents {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
}

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
      this.sessions.delete(id)
      this.events.onExit(id, exitCode)
    })
    this.sessions.set(id, pty)
    return id
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
