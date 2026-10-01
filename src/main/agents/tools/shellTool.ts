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

import { spawn } from 'child_process'
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
    promptGuidelines: ['Use shell for builds, tests and git, not to read, search or edit files'],
    description: `Run a bash command in the working directory and get its output and exit code. Long output is cut to its start and end. Times out after ${DEFAULT_TIMEOUT_SECONDS}s unless timeout says otherwise (at most ${MAX_TIMEOUT_SECONDS}s). Prefer read, find, grep and edit over cat, find, grep and sed.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        description: { type: 'string', description: 'What it does, in a few words, for the user approving it.' },
        timeout: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: 'Seconds before it is stopped.' }
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
      return runCommand(String(input.command), timeoutOf(input.timeout), context)
    }
  }
}

function timeoutOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS
  return Math.min(Math.max(1, Math.round(value)), MAX_TIMEOUT_SECONDS)
}

/** Run one command to its end, reporting its output live when the session can show it. */
function runCommand(command: string, timeoutSeconds: number, context: GroveToolContext): Promise<GroveToolResult> {
  return new Promise((resolve) => {
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
    const live = liveOutput(context, () => stop(child.pid))
    let output = ''
    let timedOut = false

    const collect = (chunk: Buffer): void => {
      const text = chunk.toString()
      output += text
      live.append(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const timer = setTimeout(() => {
      timedOut = true
      stop(child.pid)
    }, timeoutSeconds * 1000)

    child.on('error', (cause) => {
      clearTimeout(timer)
      live.end()
      resolve({ content: `Could not run the command: ${cause.message}`, isError: true })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      live.end()
      resolve(commandResult(output, code, signal, timedOut, timeoutSeconds))
    })
  })
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
  interrupt: () => void
): { append(text: string): void; end(): void } {
  const sink = context.shellOutput
  const toolCallId = context.toolCallId
  if (!sink || !toolCallId) return { append: () => {}, end: () => {} }
  sink.begin(toolCallId, interrupt)
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
