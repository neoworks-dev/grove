// Live output of the commands agents run, so the user can watch a build or a
// test run while it is going instead of when it is over.
//
// Kept apart from the event log on purpose: a build prints thousands of lines,
// and the call's result already records what it printed once it is done. A
// harness reports output through a `ShellOutputSink` bound to its session; the
// renderer gets it as updates, and asks for a snapshot when it attaches late.

import type { ShellOutputSnapshot, ShellOutputUpdate } from '../../shared/agents'

/** What the user can do to a running command, as far as whoever runs it allows. */
export interface CommandControls {
  /** Stops it the way Ctrl+C would. */
  interrupt?(): void
  /** Hands its call back to the agent while it keeps running. */
  background?(): void
  /** Types into it. */
  write?(data: string): void
  /** Resizes its terminal to the view showing it. */
  resize?(cols: number, rows: number): void
  /** Stops it and everything it started for good, when grove or the session goes away. */
  kill?(): void
}

/** What a harness calls as a command it runs prints. */
export interface ShellOutputSink {
  /** A command started, with what can be done to it while it runs. */
  begin(toolUseId: string, controls?: CommandControls): void
  append(toolUseId: string, text: string): void
  /** It started or stopped waiting for someone to type. */
  waiting?(toolUseId: string, waiting: boolean): void
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
  /** Nothing waits on it any more, though it still runs: listed for the user to stop. */
  inBackground: boolean
  /** Blocked reading its input: someone has to type. */
  waitingForInput: boolean
  controls: CommandControls
  flushTimer?: ReturnType<typeof setTimeout>
}

export class ShellOutputHub {
  private commands = new Map<string, LiveCommand>()

  constructor(private publish: (update: ShellOutputUpdate) => void) {}

  /** A sink that reports into this hub on behalf of one session. */
  sinkFor(sessionId: string): ShellOutputSink {
    return {
      begin: (toolUseId, controls) => this.begin(sessionId, toolUseId, controls),
      append: (toolUseId, text) => this.append(sessionId, toolUseId, text),
      waiting: (toolUseId, waiting) => this.setWaiting(sessionId, toolUseId, waiting),
      end: (toolUseId) => this.end(sessionId, toolUseId)
    }
  }

  /** What each command in the session has printed that the log does not have yet. */
  snapshot(sessionId: string): ShellOutputSnapshot[] {
    const found: ShellOutputSnapshot[] = []
    for (const command of this.commands.values()) {
      if (command.sessionId !== sessionId) continue
      found.push({
        toolUseId: command.toolUseId,
        text: command.text,
        running: command.running,
        background: command.inBackground,
        waitingForInput: command.waitingForInput
      })
    }
    return found
  }

  /** Stops a running command, as Ctrl+C would. False when there is nothing to stop. */
  interrupt(sessionId: string, toolUseId: string): boolean {
    const command = this.runningCommand(sessionId, toolUseId)
    if (!command || !command.controls.interrupt) return false
    command.controls.interrupt()
    return true
  }

  /** Types into a running command. False when it takes no input. */
  write(sessionId: string, toolUseId: string, data: string): boolean {
    const command = this.runningCommand(sessionId, toolUseId)
    if (!command || !command.controls.write) return false
    command.controls.write(data)
    return true
  }

  /** Resizes a running command's terminal to the view showing it. */
  resize(sessionId: string, toolUseId: string, cols: number, rows: number): boolean {
    const command = this.runningCommand(sessionId, toolUseId)
    if (!command || !command.controls.resize) return false
    command.controls.resize(cols, rows)
    return true
  }

  /** A command of the session that is still running, if there is one by that id. */
  private runningCommand(sessionId: string, toolUseId: string): LiveCommand | undefined {
    const command = this.commands.get(keyOf(sessionId, toolUseId))
    if (!command || !command.running) return undefined
    return command
  }

  /**
   * Sends every command the session is waiting on to the background, as Ctrl+B
   * does in a terminal: each call returns to the agent and the command keeps
   * running. False when none could be.
   */
  background(sessionId: string): boolean {
    let moved = false
    for (const command of this.commands.values()) {
      if (command.sessionId !== sessionId || command.settled) continue
      if (!command.running || !command.controls.background) continue
      const background = command.controls.background
      command.controls = { ...command.controls, background: undefined }
      background()
      this.markBackground(command)
      moved = true
    }
    return moved
  }

  /** Stops every command still running, when grove shuts down. */
  stopAll(): void {
    for (const command of [...this.commands.values()]) this.forget(command)
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
    if (!command.running) {
      this.forget(command)
      return
    }
    this.markBackground(command)
  }

  /** Notes that nothing waits on a running command any more, and tells the renderer. */
  private markBackground(command: LiveCommand): void {
    if (command.inBackground) return
    command.inBackground = true
    this.flush(command)
  }

  /** Every command a session had going, stopped, when the session goes away. */
  forgetSession(sessionId: string): void {
    for (const command of [...this.commands.values()]) {
      if (command.sessionId === sessionId) this.forget(command)
    }
  }

  /** Drops a command, stopping it first if it is still running in the background. */
  private forget(command: LiveCommand): void {
    if (command.running) stopForGood(command.controls)
    clearTimeout(command.flushTimer)
    this.commands.delete(keyOf(command.sessionId, command.toolUseId))
  }

  private begin(sessionId: string, toolUseId: string, controls: CommandControls = {}): void {
    const key = keyOf(sessionId, toolUseId)
    const existing = this.commands.get(key)
    if (existing) {
      existing.running = true
      existing.controls = controls
      return
    }
    this.commands.set(key, {
      sessionId,
      toolUseId,
      text: '',
      unsent: '',
      running: true,
      settled: false,
      inBackground: false,
      waitingForInput: false,
      controls
    })
    this.publish({
      sessionId,
      toolUseId,
      text: '',
      running: true,
      background: false,
      waitingForInput: false
    })
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
    command.waitingForInput = false
    command.controls = {}
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
      running: command.running,
      background: command.inBackground,
      waitingForInput: command.waitingForInput
    })
  }

  /** Notes a running command starting or stopping to wait for input, and tells the renderer. */
  private setWaiting(sessionId: string, toolUseId: string, waiting: boolean): void {
    const command = this.runningCommand(sessionId, toolUseId)
    if (!command || command.waitingForInput === waiting) return
    command.waitingForInput = waiting
    this.flush(command)
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

/** Kills a command where whoever runs it can, else interrupts it. */
function stopForGood(controls: CommandControls): void {
  if (controls.kill) {
    controls.kill()
    return
  }
  controls.interrupt?.()
}

function keyOf(sessionId: string, toolUseId: string): string {
  return `${sessionId}\0${toolUseId}`
}

/** The text, less as much of its start as it takes to fit the cap. */
function keepTail(text: string): string {
  if (text.length <= MAX_KEPT_CHARACTERS) return text
  return text.slice(text.length - MAX_KEPT_CHARACTERS)
}
