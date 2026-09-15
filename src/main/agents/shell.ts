// The `!` commands typed into the agent composer.
//
// No harness is asked to run these. Grove owns a shell already, so running the
// command here is what makes `!git status` work the same on every runtime —
// including the ones whose SDK has no shell passthrough at all. The service puts
// the result on the transcript and decides whether the model gets to see it.

import { spawn } from 'node:child_process'

export interface ShellResult {
  output: string
  exitCode: number
  /** How the run ended, in words, for the transcript and for the model. */
  outcome: string
}

export interface ShellOptions {
  cwd: string
  /** Give up and kill the command after this long. */
  timeoutMs?: number
  /** Keep at most this many characters of output, counted from the end. */
  maxOutputChars?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024

/** The exit code reported when the command could not be started at all. */
const NOT_RUN_EXIT_CODE = 127

/**
 * Run one shell command and collect what it printed.
 *
 * stdout and stderr are merged, because what the user sees in a terminal is both
 * interleaved. stdin is closed rather than piped: a command that reads input
 * should hit EOF straight away instead of hanging until the timeout.
 */
export function runShellCommand(command: string, options: ShellOptions): Promise<ShellResult> {
  const timeoutMs = timeoutOf(options)
  const limit = outputLimitOf(options)

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const chunks: string[] = []
    const collect = (chunk: Buffer): void => {
      chunks.push(chunk.toString('utf8'))
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (cause: Error) => {
      clearTimeout(timer)
      resolve({
        output: chunks.join(''),
        exitCode: NOT_RUN_EXIT_CODE,
        outcome: `could not run: ${cause.message}`
      })
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      const output = capOutput(chunks.join(''), limit)
      if (timedOut) {
        resolve({ output, exitCode: NOT_RUN_EXIT_CODE, outcome: timeoutOutcome(timeoutMs) })
        return
      }
      resolve({ output, exitCode: exitCodeOf(code, signal), outcome: outcomeOf(code, signal) })
    })
  })
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
