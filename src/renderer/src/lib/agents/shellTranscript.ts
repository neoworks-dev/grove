// A session's commands as its terminal view shows them: each command line, then
// what it printed, one after another.
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
}

/** What the view has written for one command so far. */
export interface WrittenCommand {
  toolUseId: string
  length: number
}

export interface TerminalWrite {
  /** Clear the terminal before writing. */
  reset: boolean
  /** Chunks to write, in order. */
  chunks: string[]
  written: WrittenCommand[]
}

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
    commands.push({
      toolUseId: item.toolUseId,
      command: commandOf(item),
      output: streamed ? streamed.text : item.result,
      running: streamed ? streamed.running : item.status === 'running'
    })
  }
  return commands
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
  commands.forEach((command, index) => {
    const already = kept[index]
    if (!already) {
      if (index > 0 && !endsWithNewline(commands[index - 1].output)) chunks.push('\n')
      chunks.push(commandLine(command.command))
      if (command.output) chunks.push(command.output)
      kept.push({ toolUseId: command.toolUseId, length: command.output.length })
      return
    }
    if (command.output.length > already.length) {
      chunks.push(command.output.slice(already.length))
      already.length = command.output.length
    }
  })
  return { reset, chunks, written: kept }
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
    if (command.output.length < entry.length) return false
    const isLastWritten = index === written.length - 1
    return isLastWritten || command.output.length === entry.length
  })
}

/** The command as a prompt line: dim `$`, bold command. */
function commandLine(command: string): string {
  return `\u001b[2m$\u001b[0m \u001b[1m${command}\u001b[0m\n`
}

function endsWithNewline(text: string): boolean {
  return text.length === 0 || text.endsWith('\n')
}
