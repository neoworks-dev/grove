// A session's commands as its terminal view shows them: each command line as a
// prompt, then what it printed, then — when it failed — its exit status, with a
// blank line before the next prompt so one command reads apart from the next.
//
// Output streams in while a command runs, so the view writes only what is new
// rather than redrawing; it starts over only when what it already wrote no
// longer matches (another session, or a command before the last one growing).

import type { ToolItem, TranscriptItem } from './transcript'
import type { LiveCommandOutput } from './shellOutput.svelte'

export interface ShellCommand {
  toolUseId: string
  command: string
  /** Streamed output when there was any, else the call's result. */
  output: string
  running: boolean
  /**
   * Whether the call has its result. Its output can stop streaming a moment
   * before that, and only the result says whether it failed.
   */
  finished: boolean
  /** Set once the command has finished unsuccessfully: its exit code, or null when it has none. */
  failure?: { exitCode: number | null }
}

/** What the view has written for one command so far. */
export interface WrittenCommand {
  toolUseId: string
  /** The command line as written; a call's input can arrive after the call itself. */
  command: string
  length: number
  /** Whether its end — the exit status, when it failed — has been written. */
  ended: boolean
}

export interface TerminalWrite {
  /** Clear the terminal before writing. */
  reset: boolean
  /** Chunks to write, in order. */
  chunks: string[]
  written: WrittenCommand[]
}

/** The statuses a call has once its result is in. */
const FINISHED_STATUSES = new Set<ToolItem['status']>(['ok', 'error', 'denied'])

/** The session's shell calls, oldest first, with whatever output each has. */
export function shellCommandsOf(
  items: TranscriptItem[],
  isShellCall: (item: ToolItem) => boolean,
  live: Record<string, LiveCommandOutput>
): ShellCommand[] {
  const commands: ShellCommand[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || !isShellCall(item)) continue
    const streamed = live[item.toolUseId]
    const command: ShellCommand = {
      toolUseId: item.toolUseId,
      command: commandOf(item),
      output: streamed ? streamed.text : item.result,
      running: streamed ? streamed.running : item.status === 'running',
      finished: FINISHED_STATUSES.has(item.status)
    }
    if (item.status === 'error') {
      command.failure = { exitCode: exitCodeOf(item.result) }
    }
    commands.push(command)
  }
  return commands
}

/**
 * The exit code a failed call's result names, or null when it names none.
 *
 * Harnesses report it in the result text rather than as a field: grove's own
 * shell ends with `[Exit code 2.]`, Claude Code's Bash starts with `Exit code 2`.
 */
function exitCodeOf(result: string): number | null {
  const match = /\bExit code (\d+)/.exec(result)
  if (!match) return null
  return Number.parseInt(match[1], 10)
}

/** The command line a shell call ran, as the user may have edited it. */
function commandOf(item: ToolItem): string {
  const input = (item.editedInput ?? item.input) as { command?: unknown } | null
  if (input && typeof input.command === 'string') return input.command
  return ''
}

/** What to write to bring the view from what it has to what the commands now say. */
export function planTerminalWrite(
  written: WrittenCommand[],
  commands: ShellCommand[]
): TerminalWrite {
  const reset = !continues(written, commands)
  let kept: WrittenCommand[] = []
  if (!reset) kept = written.map((entry) => ({ ...entry }))
  const chunks: string[] = []
  for (const [index, command] of commands.entries()) {
    const already = kept[index]
    if (already) {
      continueCommand(command, already, chunks)
      continue
    }
    // A call's command line can arrive after the call; its prompt waits for it,
    // and so does everything after it, to keep the order.
    if (awaitsCommandLine(command)) break
    if (index > 0) chunks.push(separatorAfter(commands[index - 1]))
    kept.push(startCommand(command, chunks))
  }
  return { reset, chunks, written: kept }
}

/** Writes a command's prompt line and what it has printed so far. */
function startCommand(command: ShellCommand, chunks: string[]): WrittenCommand {
  chunks.push(commandLine(command.command))
  if (command.output) chunks.push(command.output)
  const entry: WrittenCommand = {
    toolUseId: command.toolUseId,
    command: command.command,
    length: command.output.length,
    ended: false
  }
  endIfFinished(command, entry, chunks)
  return entry
}

/** Writes what a command printed since it was last written, and its end once it has one. */
function continueCommand(command: ShellCommand, entry: WrittenCommand, chunks: string[]): void {
  if (command.output.length > entry.length) {
    chunks.push(command.output.slice(entry.length))
    entry.length = command.output.length
  }
  endIfFinished(command, entry, chunks)
}

/** Whether a call is still waiting for its command line. */
function awaitsCommandLine(command: ShellCommand): boolean {
  return command.command === '' && !command.finished
}

/** Writes a finished command's end — its exit status, when it failed — once. */
function endIfFinished(command: ShellCommand, entry: WrittenCommand, chunks: string[]): void {
  if (!command.finished || entry.ended) return
  entry.ended = true
  if (!command.failure) return
  if (!endsWithNewline(command.output)) chunks.push('\n')
  chunks.push(failureLine(command.failure.exitCode))
}

/**
 * Whether the commands pick up where the view left off: the same calls in the
 * same order, only the last of them grown.
 */
function continues(written: WrittenCommand[], commands: ShellCommand[]): boolean {
  if (written.length > commands.length) return false
  return written.every((entry, index) => {
    const command = commands[index]
    if (command.toolUseId !== entry.toolUseId) return false
    if (command.command !== entry.command) return false
    if (command.output.length < entry.length) return false
    // Output after the end was written would land below the exit status.
    if (entry.ended && command.output.length !== entry.length) return false
    const isLastWritten = index === written.length - 1
    if (isLastWritten) return true
    // Anything above the last command is final: grown or ended since, it has to be redrawn.
    return command.output.length === entry.length && entry.ended === command.finished
  })
}

/** The command as a prompt line: a green `❯`, then the command in bold. */
function commandLine(command: string): string {
  return `\u001b[32m❯\u001b[0m \u001b[1m${command}\u001b[0m\n`
}

/** A failed command's exit status, in red, as a shell prompt would flag it. */
function failureLine(exitCode: number | null): string {
  if (exitCode === null) return '\u001b[31m✗ failed\u001b[0m\n'
  return `\u001b[31m✗ exit ${exitCode}\u001b[0m\n`
}

/** What goes between a command and the next prompt: a blank line, after a line break if its output lacked one. */
function separatorAfter(previous: ShellCommand): string {
  if (endsWithNewline(previous.output) || previous.failure) return '\n'
  return '\n\n'
}

function endsWithNewline(text: string): boolean {
  return text.length === 0 || text.endsWith('\n')
}
