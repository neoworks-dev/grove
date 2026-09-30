// Live output of the commands agents run, so the user can watch a build or a
// test run while it is going instead of when it is over.
//
// Kept apart from the event log on purpose: a build prints thousands of lines,
// and the call's result already records what it printed once it is done. A
// harness reports output through a `ShellOutputSink` bound to its session; the
// renderer gets it as updates, and asks for a snapshot when it attaches late.

import type { ShellOutputSnapshot, ShellOutputUpdate } from '../../shared/agents'

/** What a harness calls as a command it runs prints. */
export interface ShellOutputSink {
  /** A command started; `interrupt` stops it the way Ctrl+C would, when it can be. */
  begin(toolUseId: string, interrupt?: () => void): void
  append(toolUseId: string, text: string): void
  end(toolUseId: string): void
}

// Only the end of a very long run is kept; the start of a build's log is rarely
// what anyone scrolls back to while it runs.
const MAX_KEPT_CHARACTERS = 512 * 1024

// Output arrives in whatever pieces the pipe hands over. Sending each on its own
// would flood the renderer during a noisy build.
const FLUSH_DELAY_MS = 50

interface LiveCommand {
  sessionId: string
  toolUseId: string
  text: string
  unsent: string
  running: boolean
  /** The call's result is on the log. */
  settled: boolean
  interrupt?: () => void
  flushTimer?: ReturnType<typeof setTimeout>
}

export class ShellOutputHub {
  private commands = new Map<string, LiveCommand>()

  constructor(private publish: (update: ShellOutputUpdate) => void) {}

  /** A sink that reports into this hub on behalf of one session. */
  sinkFor(sessionId: string): ShellOutputSink {
    return {
      begin: (toolUseId, interrupt) => this.begin(sessionId, toolUseId, interrupt),
      append: (toolUseId, text) => this.append(sessionId, toolUseId, text),
      end: (toolUseId) => this.end(sessionId, toolUseId)
    }
  }

  /** What each command in the session has printed that the log does not have yet. */
  snapshot(sessionId: string): ShellOutputSnapshot[] {
    const found: ShellOutputSnapshot[] = []
    for (const command of this.commands.values()) {
      if (command.sessionId !== sessionId) continue
      found.push({ toolUseId: command.toolUseId, text: command.text, running: command.running })
    }
    return found
  }

  /** Stops a running command, as Ctrl+C would. False when there is nothing to stop. */
  interrupt(sessionId: string, toolUseId: string): boolean {
    const command = this.commands.get(keyOf(sessionId, toolUseId))
    if (!command || !command.running || !command.interrupt) return false
    command.interrupt()
    return true
  }

  /**
   * The call's result is on the log now, which says the rest — unless the
   * command is still going, as one sent to the background is: that one is kept
   * until it exits.
   */
  settle(sessionId: string, toolUseId: string): void {
    const command = this.commands.get(keyOf(sessionId, toolUseId))
    if (!command) return
    command.settled = true
    if (!command.running) this.forget(command)
  }

  /** Every command a session had going, when the session goes away. */
  forgetSession(sessionId: string): void {
    for (const command of [...this.commands.values()]) {
      if (command.sessionId === sessionId) this.forget(command)
    }
  }

  private forget(command: LiveCommand): void {
    clearTimeout(command.flushTimer)
    this.commands.delete(keyOf(command.sessionId, command.toolUseId))
  }

  private begin(sessionId: string, toolUseId: string, interrupt?: () => void): void {
    const key = keyOf(sessionId, toolUseId)
    const existing = this.commands.get(key)
    if (existing) {
      existing.running = true
      existing.interrupt = interrupt
      return
    }
    this.commands.set(key, {
      sessionId,
      toolUseId,
      text: '',
      unsent: '',
      running: true,
      settled: false,
      interrupt
    })
    this.publish({ sessionId, toolUseId, text: '', running: true })
  }

  private append(sessionId: string, toolUseId: string, text: string): void {
    if (text.length === 0) return
    let command = this.commands.get(keyOf(sessionId, toolUseId))
    if (!command) {
      this.begin(sessionId, toolUseId)
      command = this.commands.get(keyOf(sessionId, toolUseId))
    }
    if (!command) return
    command.text = keepTail(command.text + text)
    command.unsent += text
    if (command.flushTimer === undefined) {
      command.flushTimer = setTimeout(() => this.flush(command), FLUSH_DELAY_MS)
    }
  }

  private end(sessionId: string, toolUseId: string): void {
    const command = this.commands.get(keyOf(sessionId, toolUseId))
    if (!command || !command.running) return
    command.running = false
    command.interrupt = undefined
    this.flush(command)
    if (command.settled) this.forget(command)
  }

  /** Sends what arrived since the last update, with whether the command still runs. */
  private flush(command: LiveCommand): void {
    clearTimeout(command.flushTimer)
    command.flushTimer = undefined
    const text = command.unsent
    command.unsent = ''
    this.publish({
      sessionId: command.sessionId,
      toolUseId: command.toolUseId,
      text,
      running: command.running
    })
  }
}

// How much of the old text's end is looked for in the new text, once the new
// text no longer starts with the old.
const ANCHOR_LENGTH = 200

/**
 * What `next` adds to `previous`, for a harness that reports a command's output
 * as everything so far rather than what is new. Such output may be trimmed from
 * the front once it grows long, so when `next` no longer starts with `previous`
 * the new part is what follows the end of `previous` in it.
 */
export function addedOutput(previous: string, next: string): string {
  if (next.startsWith(previous)) return next.slice(previous.length)
  const anchor = previous.slice(-ANCHOR_LENGTH)
  const at = next.lastIndexOf(anchor)
  if (anchor.length > 0 && at >= 0) return next.slice(at + anchor.length)
  return next
}

function keyOf(sessionId: string, toolUseId: string): string {
  return `${sessionId}\0${toolUseId}`
}

/** The text, less as much of its start as it takes to fit the cap. */
function keepTail(text: string): string {
  if (text.length <= MAX_KEPT_CHARACTERS) return text
  return text.slice(text.length - MAX_KEPT_CHARACTERS)
}
