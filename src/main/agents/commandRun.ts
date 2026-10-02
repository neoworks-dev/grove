// One command run in a terminal of its own, from start to exit: what grove
// mode's shell tool and the composer's `!` both run commands with.
//
// While it runs, the command can be typed into, stopped, resized and sent to
// the background. Once a second, when it has gone quiet, grove asks the kernel
// whether it is waiting for someone to type (see inputWait). Its time limit is
// paused while it waits — nobody's answer should count against it — and a
// session in bypass mode, where nobody is there to answer, ends its input
// instead, so the agent hears about the prompt rather than hanging on it.

import { spawnInPty, type CommandExit, type CommandSpawner, type CommandTerminal } from './commandTerminal'
import { isWaitingForInput } from './inputWait'
import { ScreenText } from './screenText'

// The size a command's terminal starts at. The view showing it resizes it.
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

// How often a quiet command is checked for waiting on input, and how long it
// has to have been quiet: one still printing is not waiting.
const WAIT_CHECK_MS = 1000
const QUIET_BEFORE_CHECK_MS = 500

// After Ctrl+C, how long a command gets to stop before it is killed. A program
// that took the terminal raw (an editor, a pager) never sees Ctrl+C as a signal.
const STOP_GRACE_MS = 2000

export interface CommandRunOptions {
  command: string
  cwd: string
  /** The shell to run it with `-c`; bash when absent. */
  shell?: string
  /** What runs it; a pty unless a test asks otherwise. */
  spawn?: CommandSpawner
  /** Stop it after this long, not counting time spent waiting for input; null for never. */
  timeoutMs: number | null
  /** Called with what it prints, as it prints it. */
  onOutput?(text: string): void
  /** Called when it starts or stops waiting for input. */
  onWaiting?(waiting: boolean): void
  /** Asked when it starts waiting for input: end its input rather than wait for an answer? */
  endInputOnWait?(): boolean
}

export interface CommandOutcome {
  /** What was on its screen at the end, as plain text. */
  text: string
  /** How it ended; null when it could not be started. */
  exit: CommandExit | null
  timedOut: boolean
  /** Why it could not be started, when it could not. */
  startError?: string
  /** The prompts it was waiting at when its input was ended for it. */
  endedInputAt: string[]
}

/** A command on its way, and what can be done to it meanwhile. */
export interface RunningCommand {
  readonly pid: number | undefined
  result: Promise<CommandOutcome>
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Ctrl+C. */
  interrupt(): void
  /** Lifts the time limit: it runs until it exits or is stopped. */
  background(): void
  /** Stops it and everything it started, for good. */
  kill(): void
}

/** Starts a command in a terminal of its own. */
export function runInTerminal(options: CommandRunOptions): RunningCommand {
  const screen = new ScreenText(DEFAULT_COLS, DEFAULT_ROWS)
  let terminal: CommandTerminal
  try {
    terminal = spawnCommand(options)
  } catch (cause) {
    screen.dispose()
    return notStarted(cause)
  }
  return new CommandRun(terminal, screen, options).running()
}

/** Spawns `<shell> -c <command>` with the environment a command expects in a terminal. */
function spawnCommand(options: CommandRunOptions): CommandTerminal {
  let spawn = spawnInPty
  if (options.spawn) spawn = options.spawn
  let shell = 'bash'
  if (options.shell) shell = options.shell
  return spawn(shell, ['-c', options.command], {
    cwd: options.cwd,
    env: commandEnvironment(),
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS
  })
}

/**
 * The process's environment, plus what a terminal implies. Pagers print
 * straight through: a pager waiting on a keypress is input nobody asked for.
 */
function commandEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value
  }
  environment.TERM = 'xterm-256color'
  environment.COLORTERM = 'truecolor'
  environment.PAGER = 'cat'
  environment.GIT_PAGER = 'cat'
  return environment
}

/** A command that never started: its result is the reason, and its controls do nothing. */
function notStarted(cause: unknown): RunningCommand {
  let message = String(cause)
  if (cause instanceof Error) message = cause.message
  return {
    pid: undefined,
    result: Promise.resolve({ text: '', exit: null, timedOut: false, startError: message, endedInputAt: [] }),
    write: () => {},
    resize: () => {},
    interrupt: () => {},
    background: () => {},
    kill: () => {}
  }
}

class CommandRun {
  private lastOutputAt = Date.now()
  private waiting = false
  private checking = false
  private exited = false
  private timedOut = false
  private endedInputAt: string[] = []

  // The time limit, paused while the command waits for input.
  private remainingMs: number | null
  private timerStartedAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private waitCheck: ReturnType<typeof setInterval> | undefined
  private killTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private terminal: CommandTerminal,
    private screen: ScreenText,
    private options: CommandRunOptions
  ) {
    this.remainingMs = options.timeoutMs
  }

  /** Wires the terminal up and hands back the controls over it. */
  running(): RunningCommand {
    const result = new Promise<CommandOutcome>((resolve) => {
      this.terminal.onExit((exit) => void this.finish(exit).then(resolve))
    })
    this.terminal.onData((text) => this.absorb(text))
    this.screen.onReply((data) => this.terminal.write(data))
    this.startTimer()
    this.waitCheck = setInterval(() => void this.checkWaiting(), WAIT_CHECK_MS)
    return {
      pid: this.terminal.pid,
      result,
      write: (data) => this.terminal.write(data),
      resize: (cols, rows) => {
        this.terminal.resize(cols, rows)
        this.screen.resize(cols, rows)
      },
      interrupt: () => this.terminal.interrupt(),
      background: () => this.liftTimeout(),
      kill: () => this.terminal.kill()
    }
  }

  private absorb(text: string): void {
    this.lastOutputAt = Date.now()
    this.screen.write(text)
    this.options.onOutput?.(text)
    if (this.waiting) this.setWaiting(false)
  }

  /** Asks the kernel whether a quiet command is waiting for input, and acts on a change. */
  private async checkWaiting(): Promise<void> {
    if (this.checking || this.exited) return
    if (Date.now() - this.lastOutputAt < QUIET_BEFORE_CHECK_MS) return
    this.checking = true
    const waiting = await isWaitingForInput(this.terminal.pid).catch(() => false)
    this.checking = false
    if (this.exited || waiting === this.waiting) return
    this.setWaiting(waiting)
    if (waiting && this.options.endInputOnWait?.()) void this.endInput()
  }

  private setWaiting(waiting: boolean): void {
    this.waiting = waiting
    if (waiting) this.pauseTimer()
    if (!waiting) this.startTimer()
    this.options.onWaiting?.(waiting)
  }

  /** Ends the input of a command nobody is there to answer, noting the prompt it stopped at. */
  private async endInput(): Promise<void> {
    this.endedInputAt.push(lastLine(await this.screen.text()))
    this.terminal.endInput()
  }

  private startTimer(): void {
    if (this.remainingMs === null || this.exited) return
    clearTimeout(this.timer)
    this.timerStartedAt = Date.now()
    this.timer = setTimeout(() => this.timeOut(), this.remainingMs)
  }

  private pauseTimer(): void {
    if (this.remainingMs === null || this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.timerStartedAt))
  }

  private liftTimeout(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.remainingMs = null
  }

  /** Out of time: Ctrl+C, then a kill for a command that does not stop. */
  private timeOut(): void {
    this.timedOut = true
    this.terminal.interrupt()
    this.killTimer = setTimeout(() => this.terminal.kill(), STOP_GRACE_MS)
  }

  private async finish(exit: CommandExit): Promise<CommandOutcome> {
    this.exited = true
    clearTimeout(this.timer)
    clearTimeout(this.killTimer)
    clearInterval(this.waitCheck)
    if (this.waiting) this.options.onWaiting?.(false)
    // A pty can report the exit a moment before its last output.
    await new Promise((resolve) => setImmediate(resolve))
    const text = await this.screen.text()
    this.screen.dispose()
    return { text, exit, timedOut: this.timedOut, endedInputAt: this.endedInputAt }
  }
}

/** The last line with anything on it: the prompt a waiting command is showing. */
function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) return ''
  return lines[lines.length - 1].trim()
}
