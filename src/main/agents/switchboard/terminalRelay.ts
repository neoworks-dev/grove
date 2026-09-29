// A command's output, as switchboard reports it, moved off the log and onto
// the live shell output.
//
// switchboard reports every harness's shell the way codex-acp does: the call
// names a terminal in `_meta.terminal_info`, updates carry what it printed in
// `_meta.terminal_output_delta` (new output) or `_meta.terminal_output` (all of
// it so far), and the last one says how it exited in `_meta.terminal_exit`.
// A build prints thousands of lines, so the pieces go to the live output and
// never onto the log; the log gets the whole output once, on the update that
// settles the call, so the transcript still shows it after a restart.

import type { SessionUpdate, ToolCallUpdate } from '@neoworks/harness'
import { addedOutput, type ShellOutputSink } from '../shellOutput'

interface TerminalMeta {
  terminal_info?: { terminal_id?: unknown }
  terminal_output_delta?: { data?: unknown }
  terminal_output?: { data?: unknown }
  terminal_exit?: unknown
}

type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>

export class TerminalRelay {
  /** What each running command has printed so far, by tool call id. */
  private printed = new Map<string, string>()

  constructor(private sink: ShellOutputSink) {}

  /**
   * Pass a tool call update's output on to the live view. Returns the update
   * to log — without its output pieces — or null when output was all it carried.
   */
  relay(update: ToolUpdate): SessionUpdate | null {
    const meta = terminalMetaOf(update)
    if (!meta) return update
    const toolCallId = update.toolCallId

    if (meta.terminal_info && !this.printed.has(toolCallId)) {
      this.printed.set(toolCallId, '')
      this.sink.begin(toolCallId)
    }
    this.absorbOutput(toolCallId, meta)

    if (meta.terminal_exit !== undefined) return this.settled(update)
    if (onlyOutput(update)) return null
    return withoutOutput(update)
  }

  private absorbOutput(toolCallId: string, meta: TerminalMeta): void {
    const previous = this.printedBy(toolCallId)
    let next = previous
    if (typeof meta.terminal_output_delta?.data === 'string') next = previous + meta.terminal_output_delta.data
    if (typeof meta.terminal_output?.data === 'string') next = meta.terminal_output.data
    if (next === previous) return
    if (!this.printed.has(toolCallId)) this.sink.begin(toolCallId)
    this.printed.set(toolCallId, next)
    const added = addedOutput(previous, next)
    if (added.length > 0) this.sink.append(toolCallId, added)
  }

  private printedBy(toolCallId: string): string {
    const printed = this.printed.get(toolCallId)
    if (printed === undefined) return ''
    return printed
  }

  /** The update that ends a command, carrying its whole output as the call's result. */
  private settled(update: ToolUpdate): SessionUpdate {
    const toolCallId = update.toolCallId
    const output = this.printedBy(toolCallId)
    this.printed.delete(toolCallId)
    this.sink.end(toolCallId)
    const logged = withoutOutput(update)
    if (output.length === 0 || hasText(logged.content)) return logged
    const content: NonNullable<ToolCallUpdate['content']> = []
    if (logged.content) content.push(...logged.content)
    content.push({ type: 'content', content: { type: 'text', text: output } })
    return { ...logged, content }
  }
}

function terminalMetaOf(update: ToolUpdate): TerminalMeta | null {
  const meta = update._meta as TerminalMeta | null | undefined
  if (!meta) return null
  const known =
    meta.terminal_info !== undefined ||
    meta.terminal_output_delta !== undefined ||
    meta.terminal_output !== undefined ||
    meta.terminal_exit !== undefined
  if (!known) return null
  return meta
}

/** Whether an update says nothing but what the command printed. */
function onlyOutput(update: ToolUpdate): boolean {
  if (update.sessionUpdate !== 'tool_call_update') return false
  return (
    update.status === undefined &&
    update.content === undefined &&
    update.title === undefined &&
    update.rawInput === undefined &&
    update.rawOutput === undefined
  )
}

/** The update with the output pieces taken out of its metadata. */
function withoutOutput(update: ToolUpdate): ToolUpdate {
  const meta: Record<string, unknown> = { ...update._meta }
  delete meta.terminal_output_delta
  delete meta.terminal_output
  return { ...update, _meta: meta }
}

function hasText(content: ToolCallUpdate['content']): boolean {
  if (!content) return false
  return content.some((entry) => entry.type === 'content')
}
