// Where a command the agent or the user runs actually runs: a terminal of its
// own, so it behaves as it would in the user's shell, and so a command that
// stops to ask something can be answered rather than failing on closed input.
//
// Two ways to make one. A pty is what grove runs commands in. Pipes are the
// fallback for a runtime node-pty cannot drive: under bun, its tty stream
// treats an empty read on the pty as an error and hangs the command up, so the
// tests run commands on pipes and the pty is exercised in the app itself.

import { spawn as spawnChild } from 'node:child_process'
import { constants } from 'node:os'
import { spawn as spawnPty } from 'node-pty'

/** How a command ended: its exit code, or the signal that stopped it. */
export interface CommandExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** A running command, and everything that can be done to it. */
export interface CommandTerminal {
  readonly pid: number
  onData(listener: (text: string) => void): void
  onExit(listener: (exit: CommandExit) => void): void
  /** Types into it, as the user would at the keyboard. */
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Stops what is in the foreground, as Ctrl+C would. */
  interrupt(): void
  /** Ends its input, so a command waiting to read gets end of file. */
  endInput(): void
  /** Stops it and everything it started, for good. */
  kill(): void
}

export interface CommandSpawnOptions {
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export type CommandSpawner = (
  file: string,
  args: string[],
  options: CommandSpawnOptions
) => CommandTerminal

// What a terminal's line discipline turns into SIGINT and end of file. EOF only
// ends input at the start of a line, so a half-typed line is ended first.
const CTRL_C = '\u0003'
const CTRL_D = '\u0004'

/** Runs a command in a pty of its own, the session leader of its own process group. */
export const spawnInPty: CommandSpawner = (file, args, options) => {
  const pty = spawnPty(file, args, {
    name: 'xterm-256color',
    cwd: options.cwd,
    env: options.env,
    cols: options.cols,
    rows: options.rows
  })
  return {
    pid: pty.pid,
    onData: (listener) => {
      pty.onData(listener)
    },
    onExit: (listener) => {
      pty.onExit(({ exitCode, signal }) => listener(exitOfPty(exitCode, signal)))
    },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    interrupt: () => pty.write(CTRL_C),
    endInput: () => pty.write(`\n${CTRL_D}`),
    kill: () => signalGroup(pty.pid, 'SIGKILL')
  }
}

/**
 * Runs a command on pipes, in a process group of its own. No terminal: tools
 * see no tty, and Ctrl+C is a signal to the group rather than a keystroke.
 */
export const spawnOnPipes: CommandSpawner = (file, args, options) => {
  const child = spawnChild(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true
  })
  const pid = child.pid
  if (pid === undefined) throw new Error(`could not start ${file}`)
  child.stdin.on('error', () => {})
  return {
    pid,
    onData: (listener) => {
      child.stdout.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')))
    },
    onExit: (listener) => {
      child.on('close', (code, signal) => listener({ code, signal }))
    },
    write: (data) => {
      if (child.stdin.writable) child.stdin.write(data)
    },
    resize: () => {},
    interrupt: () => signalGroup(pid, 'SIGINT'),
    endInput: () => child.stdin.end(),
    kill: () => signalGroup(pid, 'SIGKILL')
  }
}

/** node-pty reports a signal by number, and 0 when there was none. */
function exitOfPty(exitCode: number, signal: number | undefined): CommandExit {
  if (!signal) return { code: exitCode, signal: null }
  return { code: null, signal: signalName(signal) }
}

/** The name of a signal number, e.g. 2 → SIGINT. */
function signalName(signal: number): NodeJS.Signals | null {
  const names = Object.keys(constants.signals) as NodeJS.Signals[]
  const found = names.find((name) => constants.signals[name] === signal)
  if (found === undefined) return null
  return found
}

/** Signals a command's whole process group. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // Already gone.
  }
}
