// A debug adapter for the debugger's tests: it speaks DAP over any pair of
// streams and "runs" a program of `lineCount` lines, stopping on breakpoints
// and stepping one line at a time. Its variables are the current line, so a
// test can tell one stop's values from the next.

import type { Readable, Writable } from 'node:stream'

interface Message {
  seq: number
  type: string
  command?: string
  arguments?: Record<string, unknown>
}

const THREAD_ID = 1
const LOCALS_REFERENCE = 1
const ITEMS_REFERENCE = 2

/** Serves one debug session over the streams until the client disconnects. */
export function runFakeAdapter(input: Readable, output: Writable, lineCount = 10): void {
  let sequence = 0
  let buffer = Buffer.alloc(0)
  let program = ''
  let currentLine = 0
  let breakpointLines: number[] = []
  let ended = false

  const send = (message: Record<string, unknown>): void => {
    sequence += 1
    const json = JSON.stringify({ ...message, seq: sequence })
    output.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
  }
  const respond = (request: Message, body: unknown = {}): void => {
    send({
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: true,
      body
    })
  }
  const event = (name: string, body: unknown = {}): void => {
    send({ type: 'event', event: name, body })
  }
  const stopAt = (line: number, reason: string): void => {
    currentLine = line
    event('stopped', { reason, threadId: THREAD_ID, allThreadsStopped: true })
  }
  const finish = (): void => {
    ended = true
    event('exited', { exitCode: 0 })
    event('terminated')
  }
  /** Runs from after `line` to the next breakpoint, or to the end. */
  const runFrom = (line: number): void => {
    const next = breakpointLines.filter((candidate) => candidate > line).sort((a, b) => a - b)[0]
    if (next === undefined) {
      finish()
      return
    }
    stopAt(next, 'breakpoint')
  }

  const handle = (request: Message): void => {
    const args = request.arguments || {}
    switch (request.command) {
      case 'initialize':
        respond(request, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
          exceptionBreakpointFilters: [
            { filter: 'raised', label: 'Raised Exceptions', default: false },
            { filter: 'uncaught', label: 'Uncaught Exceptions', default: true }
          ]
        })
        return
      case 'launch':
        program = String(args.program)
        // Like debugpy: `initialized` comes once launch arrives, and the
        // launch answer only after configurationDone.
        event('initialized')
        pendingLaunch = request
        return
      case 'setBreakpoints': {
        const breakpoints = (args.breakpoints as { line: number }[]) || []
        breakpointLines = breakpoints.map((breakpoint) => breakpoint.line)
        respond(request, {
          breakpoints: breakpoints.map((breakpoint, index) => ({
            id: index + 100,
            verified: breakpoint.line <= lineCount,
            line: breakpoint.line
          }))
        })
        return
      }
      case 'setExceptionBreakpoints':
        respond(request)
        return
      case 'configurationDone':
        respond(request)
        if (pendingLaunch) {
          respond(pendingLaunch)
          pendingLaunch = null
        }
        event('output', { category: 'stdout', output: `running ${program}\n` })
        runFrom(0)
        return
      case 'threads':
        respond(request, { threads: [{ id: THREAD_ID, name: 'MainThread' }] })
        return
      case 'stackTrace':
        respond(request, {
          stackFrames: [
            {
              id: 1000 + currentLine,
              name: 'main',
              line: currentLine,
              column: 1,
              source: { path: program, name: 'program' }
            },
            { id: 1, name: '<module>', line: 1, column: 1, source: { name: 'runner' } }
          ],
          totalFrames: 2
        })
        return
      case 'scopes':
        respond(request, {
          scopes: [{ name: 'Locals', variablesReference: LOCALS_REFERENCE, expensive: false }]
        })
        return
      case 'variables':
        if (args.variablesReference === ITEMS_REFERENCE) {
          respond(request, {
            variables: [
              { name: '0', value: "'a'", variablesReference: 0 },
              { name: '1', value: "'b'", variablesReference: 0 }
            ]
          })
          return
        }
        respond(request, {
          variables: [
            { name: 'line', value: String(currentLine), type: 'int', variablesReference: 0 },
            { name: 'items', value: 'list[2]', type: 'list', variablesReference: ITEMS_REFERENCE }
          ]
        })
        return
      case 'evaluate':
        respond(request, {
          result: `${String(args.expression)}@${currentLine}`,
          variablesReference: 0
        })
        return
      case 'next':
        respond(request)
        if (currentLine >= lineCount) {
          finish()
          return
        }
        stopAt(currentLine + 1, 'step')
        return
      case 'continue':
        respond(request, { allThreadsContinued: true })
        runFrom(currentLine)
        return
      case 'terminate':
        // A program that already ended has nothing left to terminate; like
        // debugpy, say so by answering and sending nothing more.
        respond(request)
        if (!ended) {
          finish()
        }
        return
      case 'disconnect':
        respond(request)
        output.end()
        return
      default:
        send({
          type: 'response',
          request_seq: request.seq,
          command: request.command,
          success: false,
          message: `unsupported: ${request.command}`
        })
    }
  }

  let pendingLaunch: Message | null = null

  input.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const length = Number(
        /Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())?.[1]
      )
      const start = headerEnd + 4
      if (buffer.length < start + length) return
      const message: Message = JSON.parse(buffer.subarray(start, start + length).toString())
      buffer = buffer.subarray(start + length)
      handle(message)
    }
  })
}
