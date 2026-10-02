// The commands a session has left running with nothing waiting on them: an
// agent's run_in_background call, or a command — the agent's or a `!` one —
// sent to the background with Ctrl+B. Its call has returned, so the transcript
// no longer offers a Stop for it; the composer lists these instead.

import type { TranscriptItem } from './transcript'
import type { LiveCommandOutput } from './shellOutput.svelte'

export interface BackgroundCommand {
  /** The id its output streams under, which Stop goes to. */
  id: string
  command: string
}

/** The session's running background commands, oldest first, each with its command line. */
export function backgroundCommandsOf(
  items: TranscriptItem[],
  live: Record<string, LiveCommandOutput>
): BackgroundCommand[] {
  const commands: BackgroundCommand[] = []
  for (const item of items) {
    const id = streamIdOf(item)
    if (id === null) continue
    const output = live[id]
    if (!output || !output.running || !output.background) continue
    commands.push({ id, command: commandLineOf(item) })
  }
  return commands
}

/** The id an item's live output streams under, or null for an item that runs nothing. */
function streamIdOf(item: TranscriptItem): string | null {
  if (item.kind === 'tool') return item.toolUseId
  if (item.kind === 'shell') return item.shellId
  return null
}

/** The command line an item ran, or the call's title when its input has none. */
function commandLineOf(item: TranscriptItem): string {
  if (item.kind === 'shell') return item.command
  if (item.kind !== 'tool') return ''
  const input = (item.editedInput ?? item.input) as { command?: unknown } | null
  if (input && typeof input.command === 'string') return input.command
  return item.title
}
