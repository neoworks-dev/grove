// Watching Claude's Bash commands run.
//
// Claude Code only reports a command once it has finished. It does hand every
// command it runs to CLAUDE_CODE_SHELL_PREFIX, though, so grove sets that to
// resources/agent-shell/prefix.sh, which runs Bash commands through tee.cjs:
// output passes through untouched and is copied to the socket here as it comes.
// Each copy names its session and the command it runs; the session's run says
// which of its open Bash calls that is.

import { existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShellOutputSink } from '../shellOutput'

/** What a session's run tells the server about its Bash calls. */
export interface ShellTeeSession {
  /** The open Bash call running this command, or null when none is. */
  callFor(command: string): string | null
  sink: ShellOutputSink
}

interface TeeMessage {
  type?: unknown
  sessionId?: unknown
  command?: unknown
  text?: unknown
}

const sessions = new Map<string, ShellTeeSession>()
let server: Server | null = null
let listening: Promise<string | null> | null = null

/**
 * The variables that route a session's Bash commands through the tee, or none
 * when it can't be: on Windows, without the shipped scripts, or when the user
 * set a prefix of their own, which is theirs to keep.
 */
export async function shellTeeEnvironment(
  sessionId: string,
  session: ShellTeeSession
): Promise<Record<string, string>> {
  if (process.platform === 'win32' || process.env.CLAUDE_CODE_SHELL_PREFIX) return {}
  const prefix = join(await agentShellRoot(), 'prefix.sh')
  if (!existsSync(prefix)) return {}
  const socketPath = await listen()
  if (!socketPath) return {}
  sessions.set(sessionId, session)
  return {
    CLAUDE_CODE_SHELL_PREFIX: prefix,
    GROVE_SHELL_SOCKET: socketPath,
    GROVE_NODE: process.execPath,
    GROVE_SESSION_ID: sessionId
  }
}

/** Stop routing a session's commands; its run is gone. */
export function forgetShellTeeSession(sessionId: string, session: ShellTeeSession): void {
  if (sessions.get(sessionId) === session) sessions.delete(sessionId)
}

/**
 * Where prefix.sh and tee.cjs are, in a packaged build and in development.
 * Electron is imported here rather than at the top so the harness still loads
 * outside it, as the tests load it.
 */
async function agentShellRoot(): Promise<string> {
  const { app } = await import('electron')
  if (app.isPackaged) return join(process.resourcesPath, 'agent-shell')
  return join(app.getAppPath(), 'resources', 'agent-shell')
}

/** Starts the socket once per app; resolves to its path, or null if it would not listen. */
function listen(): Promise<string | null> {
  if (listening) return listening
  const socketPath = join(tmpdir(), `grove-shell-${process.pid}.sock`)
  listening = new Promise((resolve) => {
    removeSocket(socketPath)
    server = createServer(acceptTee)
    server.once('error', () => resolve(null))
    server.listen(socketPath, () => resolve(socketPath))
    process.once('exit', () => removeSocket(socketPath))
  })
  return listening
}

function removeSocket(socketPath: string): void {
  try {
    unlinkSync(socketPath)
  } catch {
    // Not there.
  }
}

/** One command's copy: find its call from the first message, then pass the rest on. */
function acceptTee(socket: Socket): void {
  let sessionId: string | null = null
  let toolUseId: string | null = null
  let pending = ''

  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('data', (data: string) => {
    pending += data
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      handle(parse(pending.slice(0, newline)))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  })
  socket.on('close', () => {
    if (sessionId && toolUseId) sessions.get(sessionId)?.sink.end(toolUseId)
  })

  function handle(message: TeeMessage | null): void {
    if (!message) return
    if (message.type === 'start') {
      start(message)
      return
    }
    if (!sessionId || !toolUseId) return
    const sink = sessions.get(sessionId)?.sink
    if (!sink) return
    if (message.type === 'output' && typeof message.text === 'string') {
      sink.append(toolUseId, message.text)
      return
    }
    if (message.type === 'exit') sink.end(toolUseId)
  }

  function start(message: TeeMessage): void {
    if (typeof message.sessionId !== 'string' || typeof message.command !== 'string') return
    const session = sessions.get(message.sessionId)
    if (!session) return
    const call = session.callFor(message.command)
    if (!call) return
    sessionId = message.sessionId
    toolUseId = call
    session.sink.begin(call, () => {
      socket.write(`${JSON.stringify({ type: 'interrupt' })}\n`)
    })
  }
}

function parse(line: string): TeeMessage | null {
  try {
    const value: unknown = JSON.parse(line)
    if (value && typeof value === 'object') return value as TeeMessage
    return null
  } catch {
    return null
  }
}

/**
 * Which of the open Bash calls runs `command`. Only an exact match counts: a
 * quick command's result can arrive before its copy does, and guessing then
 * would put its output on some other call.
 */
export function matchBashCall(openCalls: Map<string, string>, command: string): string | null {
  for (const [toolUseId, callCommand] of openCalls) {
    if (callCommand === command) return toolUseId
  }
  return null
}
