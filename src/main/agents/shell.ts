// The `!` commands typed into the agent composer.
//
// No harness is asked to run these. Grove owns a shell already, so running the
// command here is what makes `!git status` work the same on every runtime —
// including the ones whose SDK has no shell passthrough at all. The service puts
// the result on the transcript and decides whether the model gets to see it.

import type { CommandSpawner } from './commandTerminal'
import { runInTerminal, type CommandOutcome } from './commandRun'

export interface ShellResult {
  output: string
  exitCode: number
  /** How the run ended, in words, for the transcript and for the model. */
  outcome: string
}

export interface ShellOptions {
  cwd: string
  /** The shell to run it in; the platform default (/bin/sh) when absent. */
  shell?: string
  /** Give up and kill the command after this long. */
  timeoutMs?: number
  /** Keep at most this many characters of output, counted from the end. */
  maxOutputChars?: number
  /** Called with what the command prints, as it prints it. */
  onOutput?(text: string): void
  /** Called when it starts or stops waiting for someone to type. */
  onWaiting?(waiting: boolean): void
  /** What runs it; a pty unless a test asks for pipes. */
  spawn?: CommandSpawner
}

/** A `!` command on its way, and what the user can do to it meanwhile. */
export interface RunningShellCommand {
  result: Promise<ShellResult>
  /** Stops it and everything it started, as Ctrl+C would. */
  interrupt(): void
  /** Lifts the timeout, so it runs until it exits or is stopped (Ctrl+B). */
  background(): void
  /** Types into it. */
  write(data: string): void
  /** Resizes its terminal to the view showing it. */
  resize(cols: number, rows: number): void
  /** Stops it and everything it started, for good. */
  kill(): void
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024

/** The exit code reported when the command could not be started at all. */
const NOT_RUN_EXIT_CODE = 127

/**
 * Run one shell command and collect what it printed: the text left on its
 * terminal's screen, so stdout and stderr interleaved as the user saw them.
 * A command that reads input waits for it, its time limit paused.
 */
export function runShellCommand(command: string, options: ShellOptions): Promise<ShellResult> {
  return startShellCommand(command, options).result
}

/**
 * Start one shell command in a terminal of its own, and hand back its result
 * with the controls the user has over it while it runs.
 */
export function startShellCommand(command: string, options: ShellOptions): RunningShellCommand {
  const timeoutMs = timeoutOf(options)
  const running = runInTerminal({
    command,
    cwd: options.cwd,
    shell: options.shell,
    spawn: options.spawn,
    timeoutMs,
    onOutput: options.onOutput,
    onWaiting: options.onWaiting
  })
  return {
    result: running.result.then((outcome) => shellResultOf(outcome, timeoutMs, outputLimitOf(options))),
    interrupt: () => running.interrupt(),
    background: () => running.background(),
    write: (data) => running.write(data),
    resize: (cols, rows) => running.resize(cols, rows),
    kill: () => running.kill()
  }
}

/** How a finished command is reported on the transcript. */
function shellResultOf(outcome: CommandOutcome, timeoutMs: number, limit: number): ShellResult {
  if (outcome.startError !== undefined) {
    return { output: '', exitCode: NOT_RUN_EXIT_CODE, outcome: `could not run: ${outcome.startError}` }
  }
  const output = capOutput(outcome.text, limit)
  if (outcome.timedOut) {
    return { output, exitCode: NOT_RUN_EXIT_CODE, outcome: timeoutOutcome(timeoutMs) }
  }
  let code: number | null = null
  let signal: NodeJS.Signals | null = null
  if (outcome.exit) {
    code = outcome.exit.code
    signal = outcome.exit.signal
  }
  return { output, exitCode: exitCodeOf(code, signal), outcome: outcomeOf(code, signal) }
}

function timeoutOf(options: ShellOptions): number {
  if (typeof options.timeoutMs === 'number') return options.timeoutMs
  return DEFAULT_TIMEOUT_MS
}

function outputLimitOf(options: ShellOptions): number {
  if (typeof options.maxOutputChars === 'number') return options.maxOutputChars
  return DEFAULT_MAX_OUTPUT_CHARS
}

/**
 * The tail of the output, since the end of a long run is what the command was
 * asked for. What was dropped is named, so neither the reader nor the model
 * mistakes a truncated log for the whole of it.
 */
function capOutput(text: string, limit: number): string {
  if (text.length <= limit) return text
  const dropped = text.length - limit
  return `[${dropped} earlier characters dropped]\n${text.slice(-limit)}`
}

/** A signalled command has no exit code of its own; report it the way a shell does. */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code
  if (signal) return 128
  return NOT_RUN_EXIT_CODE
}

function outcomeOf(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `killed by ${signal}`
  if (code === 0) return 'exit 0'
  return `exit ${code}`
}

function timeoutOutcome(timeoutMs: number): string {
  if (timeoutMs < 1000) return `timed out after ${timeoutMs}ms`
  return `timed out after ${Math.round(timeoutMs / 1000)}s`
}
