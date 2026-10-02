// Running commands in grove mode.
//
// Each command runs in a terminal of its own (see commandRun), so it behaves
// as in the user's shell and can be typed into from the agent terminal. What it
// prints streams to the transcript as it runs, the same way a harness's own
// shell does. What goes back to the model is the text that was on the
// terminal's screen — colour and progress-bar redraws gone — cut to its start
// and its end: a build's middle is rarely what the next step turns on, and
// every line of it would be paid for again on every later turn.
//
// A command that stops to ask for input waits for the user, its time limit
// paused. In bypass mode nobody is there to answer, so its input is ended
// instead and the agent is told what it asked.

import type { GroveTool, GroveToolContext, GroveToolResult } from '../harness'
import type { CommandSpawner } from '../commandTerminal'
import { runInTerminal, type CommandOutcome, type RunningCommand } from '../commandRun'

const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 600
/** Characters of output the model is given from the start and from the end. */
const HEAD_CHARACTERS = 2000
const TAIL_CHARACTERS = 14000

// Colour and cursor sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`)
// and character-set selection (`ESC ( B`, which `tput sgr0` emits).
const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]/g

/** The shell tool. `spawn` picks what runs commands; a pty unless a test asks for pipes. */
export function shellTool(spawn?: CommandSpawner): GroveTool {
  return {
    name: 'shell',
    alwaysLoad: true,
    summary: 'Run a command',
    promptGuidelines: [
      'Use shell for builds, tests and git, not to read, search or edit files',
      'Start dev servers, watchers and other long runs with run_in_background, then carry on; you are told when they exit'
    ],
    description: `Run a bash command in the working directory and get its output and exit code. Long output is cut to its start and end. Times out after ${DEFAULT_TIMEOUT_SECONDS}s unless timeout says otherwise (at most ${MAX_TIMEOUT_SECONDS}s). With run_in_background the call returns at once with the process id, the command runs on without a timeout, and a message with its exit code and the end of its output arrives when it exits; stop it with kill. The user can also send a running command to the background, which returns the call the same way. Prefer read, find, grep and edit over cat, find, grep and sed.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        description: { type: 'string', description: 'What it does, in a few words, for the user approving it.' },
        timeout: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: 'Seconds before it is stopped.' },
        run_in_background: {
          type: 'boolean',
          description: 'Return straight away and leave the command running; you are told when it exits.'
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    policy: 'ask',
    display: { label: '{command}', input: 'command', result: 'code' },

    describe(input) {
      return Promise.resolve({ kind: 'execute', title: String(input.command) })
    },

    execute(input, context) {
      const command = String(input.command)
      if (input.run_in_background === true) return runInBackground(command, context, spawn)
      return runCommand(command, timeoutOf(input.timeout), context, spawn)
    }
  }
}

function timeoutOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS
  return Math.min(Math.max(1, Math.round(value)), MAX_TIMEOUT_SECONDS)
}

/**
 * Starts a command in its own terminal, its output streamed to the session and
 * its controls handed to the session's live view. `background` is what Ctrl+B
 * on it does, when anything.
 */
function startCommand(
  command: string,
  context: GroveToolContext,
  timeoutSeconds: number | null,
  spawn: CommandSpawner | undefined,
  background?: () => void
): RunningCommand {
  const sink = context.shellOutput
  const toolCallId = context.toolCallId
  let timeoutMs: number | null = null
  if (timeoutSeconds !== null) timeoutMs = timeoutSeconds * 1000
  const running = runInTerminal({
    command,
    cwd: context.workspaceRoot,
    spawn,
    timeoutMs,
    onOutput: (text) => {
      if (sink && toolCallId) sink.append(toolCallId, text)
    },
    onWaiting: (waiting) => {
      if (sink && toolCallId) sink.waiting?.(toolCallId, waiting)
    },
    endInputOnWait: () => isBypass(context)
  })
  if (sink && toolCallId) {
    sink.begin(toolCallId, {
      interrupt: () => running.interrupt(),
      background,
      write: (data) => running.write(data),
      resize: (cols, rows) => running.resize(cols, rows),
      kill: () => running.kill()
    })
    void running.result.then(() => sink.end(toolCallId))
  }
  return running
}

/** Whether the session runs without asking: nobody is there to answer a prompt. */
function isBypass(context: GroveToolContext): boolean {
  if (!context.permissionMode) return false
  return context.permissionMode() === 'bypass'
}

/**
 * Run one command to its end. Sent to the background on the way, the call
 * returns there and then, and the agent hears about the end in a message
 * instead.
 */
function runCommand(
  command: string,
  timeoutSeconds: number,
  context: GroveToolContext,
  spawn: CommandSpawner | undefined
): Promise<GroveToolResult> {
  return new Promise((resolve) => {
    let returned = false
    let running: RunningCommand | undefined
    const sendToBackground = (): void => {
      if (returned || !running) return
      returned = true
      running.background()
      resolve({ content: backgroundedResult(running.pid, 'The user sent the command to the background') })
    }
    let background: (() => void) | undefined
    if (canNotify(context)) background = sendToBackground
    running = startCommand(command, context, timeoutSeconds, spawn, background)
    void running.result.then((outcome) => {
      const result = resultOf(outcome, timeoutSeconds)
      if (returned) {
        notifyExit(context, command, result)
        return
      }
      returned = true
      resolve(result)
    })
  })
}

/** Start a command and return at once; the agent is told when it exits. */
function runInBackground(
  command: string,
  context: GroveToolContext,
  spawn: CommandSpawner | undefined
): GroveToolResult {
  if (!canNotify(context)) {
    return { content: 'This session cannot run commands in the background.', isError: true }
  }
  const running = startCommand(command, context, null, spawn)
  void running.result.then((outcome) => notifyExit(context, command, resultOf(outcome, 0)))
  return { content: backgroundedResult(running.pid, 'Started in the background') }
}

/** What the model is told of a finished command. */
function resultOf(outcome: CommandOutcome, timeoutSeconds: number): GroveToolResult {
  if (outcome.startError !== undefined) {
    return { content: `Could not run the command: ${outcome.startError}`, isError: true }
  }
  let code: number | null = null
  let signal: NodeJS.Signals | null = null
  if (outcome.exit) {
    code = outcome.exit.code
    signal = outcome.exit.signal
  }
  const result = commandResult(outcome.text, code, signal, outcome.timedOut, timeoutSeconds)
  if (outcome.endedInputAt.length === 0) return result
  return { ...result, content: `${result.content}\n${endedInputNote(outcome.endedInputAt)}` }
}

/** Says which prompts went unanswered because the session runs in bypass mode. */
function endedInputNote(prompts: string[]): string {
  const asked = prompts.map((prompt) => `"${prompt}"`).join(', ')
  return `[It stopped to wait for input at ${asked}. Nobody answers prompts in bypass mode, so its input was ended. Run it without needing input, or ask the user to run it.]`
}

/** Whether the session can hear about a command after its call has returned. */
function canNotify(context: GroveToolContext): boolean {
  return context.notify !== undefined
}

/** What the call returns once its command goes on without it. */
function backgroundedResult(pid: number | undefined, how: string): string {
  return `${how} (process group ${pid}). It keeps running; you get a message when it exits. Stop it with \`kill -- -${pid}\`.`
}

/** Tell the agent a command it is no longer waiting on has exited. */
function notifyExit(context: GroveToolContext, command: string, result: GroveToolResult): void {
  if (!context.notify) return
  context.notify('Background command finished', `$ ${command}\n${result.content}`)
}

export function commandResult(
  output: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  timeoutSeconds: number
): GroveToolResult {
  const parts: string[] = []
  const trimmed = shortened(withoutEscapes(output).trimEnd())
  if (trimmed.length > 0) parts.push(trimmed)
  if (timedOut) parts.push(`[Stopped after ${timeoutSeconds}s.]`)
  else if (signal) parts.push(`[Killed by ${signal}.]`)
  else if (code !== 0) parts.push(`[Exit code ${code}.]`)
  if (parts.length === 0) parts.push('(no output)')
  return { content: parts.join('\n'), isError: timedOut || code !== 0 }
}

/** Output as plain text: the colour and cursor sequences a terminal would act on, removed. */
function withoutEscapes(output: string): string {
  return output.replace(ANSI_ESCAPE, '')
}

/** Output cut to its start and its end when it is too long to hand over whole. */
function shortened(output: string): string {
  if (output.length <= HEAD_CHARACTERS + TAIL_CHARACTERS) return output
  const head = output.slice(0, HEAD_CHARACTERS)
  const tail = output.slice(output.length - TAIL_CHARACTERS)
  const skipped = output.slice(HEAD_CHARACTERS, output.length - TAIL_CHARACTERS).split('\n').length
  return `${head}\n[… ${skipped} lines cut …]\n${tail}`
}
