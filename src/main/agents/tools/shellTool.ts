// Running commands in grove mode.
//
// What a command prints streams to the transcript as it runs, the same way a
// harness's own shell does. What goes back to the model is cut to its start and
// its end: a build's middle is rarely what the next step turns on, and every
// line of it would be paid for again on every later turn.

import { spawn } from 'child_process'
import type { GroveTool, GroveToolContext, GroveToolResult } from '../harness'

const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 600
/** Characters of output the model is given from the start and from the end. */
const HEAD_CHARACTERS = 2000
const TAIL_CHARACTERS = 14000

export function shellTool(): GroveTool {
  return {
    name: 'shell',
    summary: 'Run a command',
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
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
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
  const trimmed = shortened(output.trimEnd())
  if (trimmed.length > 0) parts.push(trimmed)
  if (timedOut) parts.push(`[Stopped after ${timeoutSeconds}s.]`)
  else if (signal) parts.push(`[Killed by ${signal}.]`)
  else if (code !== 0) parts.push(`[Exit code ${code}.]`)
  if (parts.length === 0) parts.push('(no output)')
  return { content: parts.join('\n'), isError: timedOut || code !== 0 }
}

/** Output cut to its start and its end when it is too long to hand over whole. */
function shortened(output: string): string {
  if (output.length <= HEAD_CHARACTERS + TAIL_CHARACTERS) return output
  const head = output.slice(0, HEAD_CHARACTERS)
  const tail = output.slice(output.length - TAIL_CHARACTERS)
  const skipped = output.slice(HEAD_CHARACTERS, output.length - TAIL_CHARACTERS).split('\n').length
  return `${head}\n[… ${skipped} lines cut …]\n${tail}`
}
