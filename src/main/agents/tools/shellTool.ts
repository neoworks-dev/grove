// Running commands in grove mode.
//
// What a command prints streams to the transcript as it runs, the same way a
// harness's own shell does. What goes back to the model is cut to its start and
// its end: a build's middle is rarely what the next step turns on, and every
// line of it would be paid for again on every later turn.
//
// A command runs on pipes, not a terminal, so tools would drop their colours.
// It is told to keep them, for the transcript's terminal; the model is given
// the same output with the escapes taken out, since to it they are only noise.
// The environment asks for colour rather than a pty giving a terminal: a pty
// would also change what the model reads — tools lay out for its width, draw
// progress bars, wait on a prompt instead of seeing no input — where the
// environment changes the colour and nothing else.

import { spawn, type ChildProcess } from 'child_process'
import type { GroveTool, GroveToolContext, GroveToolResult } from '../harness'

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

export function shellTool(): GroveTool {
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
      if (input.run_in_background === true) return runInBackground(command, context)
      return runCommand(command, timeoutOf(input.timeout), context)
    }
  }
}

function timeoutOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS
  return Math.min(Math.max(1, Math.round(value)), MAX_TIMEOUT_SECONDS)
}

/** A command's process, as the helpers below follow it. */
interface StartedCommand {
  child: ChildProcess
  live: { append(text: string): void; end(): void }
  /** Everything it printed so far. */
  output(): string
}

/**
 * Start a command in its own process group, its output collected and streamed
 * to the session. `background` is what Ctrl+B on it does, when anything.
 */
function startCommand(
  command: string,
  context: GroveToolContext,
  background?: () => void
): StartedCommand {
  const child = spawn('bash', ['-c', command], {
    cwd: context.workspaceRoot,
    env: {
      ...colourEnvironment(),
      ...process.env,
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it stops what it started too.
    detached: true
  })
  const live = liveOutput(context, () => stop(child.pid), background)
  let output = ''
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString()
    output += text
    live.append(text)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  return { child, live, output: () => output }
}

/**
 * Run one command to its end, reporting its output live when the session can
 * show it. Sent to the background on the way, the call returns there and then
 * and the agent hears about the end in a message instead.
 */
function runCommand(command: string, timeoutSeconds: number, context: GroveToolContext): Promise<GroveToolResult> {
  return new Promise((resolve) => {
    let returned = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const sendToBackground = (): void => {
      if (returned) return
      returned = true
      clearTimeout(timer)
      resolve({ content: backgroundedResult(started.child.pid, 'The user sent the command to the background') })
    }
    const started = startCommand(command, context, canNotify(context) ? sendToBackground : undefined)

    timer = setTimeout(() => {
      timedOut = true
      stop(started.child.pid)
    }, timeoutSeconds * 1000)

    started.child.on('error', (cause) => {
      clearTimeout(timer)
      started.live.end()
      if (returned) return
      returned = true
      resolve({ content: `Could not run the command: ${cause.message}`, isError: true })
    })
    started.child.on('close', (code, signal) => {
      clearTimeout(timer)
      started.live.end()
      const result = commandResult(started.output(), code, signal, timedOut, timeoutSeconds)
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
function runInBackground(command: string, context: GroveToolContext): GroveToolResult {
  if (!canNotify(context)) {
    return { content: 'This session cannot run commands in the background.', isError: true }
  }
  const started = startCommand(command, context)
  started.child.on('error', (cause) => {
    started.live.end()
    notifyExit(context, command, { content: `Could not run the command: ${cause.message}`, isError: true })
  })
  started.child.on('close', (code, signal) => {
    started.live.end()
    notifyExit(context, command, commandResult(started.output(), code, signal, false, 0))
  })
  return { content: backgroundedResult(started.child.pid, 'Started in the background') }
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

/**
 * What asks a tool to colour its output though it is writing to a pipe:
 * `FORCE_COLOR` for Node's ecosystem and most test runners, `CLICOLOR_FORCE`
 * for the tools that follow the CLICOLOR convention. Spread before the
 * process's own environment, so a user who set either keeps their value; and
 * left out entirely when they asked for no colour at all.
 */
function colourEnvironment(): Record<string, string> {
  if (process.env.NO_COLOR) return {}
  return { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' }
}

/** The session's live output for this call, or a sink that drops it. */
function liveOutput(
  context: GroveToolContext,
  interrupt: () => void,
  background?: () => void
): { append(text: string): void; end(): void } {
  const sink = context.shellOutput
  const toolCallId = context.toolCallId
  if (!sink || !toolCallId) return { append: () => {}, end: () => {} }
  sink.begin(toolCallId, interrupt, background)
  return {
    append: (text) => sink.append(toolCallId, text),
    end: () => sink.end(toolCallId)
  }
}

/** Stop a command and everything it started, as Ctrl+C would. */
function stop(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGINT')
  } catch {
    // Already gone.
  }
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
