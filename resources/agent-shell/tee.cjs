'use strict'
// Runs one of Claude Code's Bash commands for prefix.sh, passing its output
// through untouched and copying it to grove as it arrives, so the user can
// watch a command that Claude only reports once it has finished.
//
// Runs on grove's own Electron binary as Node (ELECTRON_RUN_AS_NODE), so it
// needs nothing installed. Grove going away must never break the command: a
// socket that fails just stops the copy.
//
// Messages are JSON lines. Out: start {sessionId, command}, output {stream,
// text}, exit {code, signal}. In: interrupt, which is Ctrl+C from the user.

const net = require('node:net')
const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')

const [, , shell, commandLine] = process.argv

// Claude wraps the command it was given: `… && eval '<command>' < /dev/null &&
// pwd -P >| <file>`. Grove matches the call by the command inside.
function commandOf(line) {
  const match = /eval '((?:[^']|'\\'')*)'/.exec(line)
  if (!match) return line
  return match[1].replace(/'\\''/g, "'")
}

let socketOpen = true
const socket = net.createConnection(process.env.GROVE_SHELL_SOCKET)
socket.on('error', () => {
  socketOpen = false
})
socket.on('close', () => {
  socketOpen = false
})

function send(message) {
  if (!socketOpen) return
  socket.write(`${JSON.stringify(message)}\n`)
}

send({ type: 'start', sessionId: process.env.GROVE_SESSION_ID, command: commandOf(commandLine) })

// Its own process group, so an interrupt reaches everything the command started
// rather than only the shell running it.
const child = spawn(shell, ['-c', commandLine], {
  stdio: ['inherit', 'pipe', 'pipe'],
  detached: true
})

function copy(source, target, stream) {
  const decoder = new StringDecoder('utf8')
  source.on('data', (chunk) => {
    target.write(chunk)
    const text = decoder.write(chunk)
    if (text) send({ type: 'output', stream, text })
  })
  source.on('end', () => {
    const rest = decoder.end()
    if (rest) send({ type: 'output', stream, text: rest })
  })
}
copy(child.stdout, process.stdout, 'stdout')
copy(child.stderr, process.stderr, 'stderr')

function signalChild(signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    // Already gone.
  }
}

// Whatever Claude sends this process — its own interrupt, a timeout — goes to
// the command as well.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => signalChild(signal))
}

// Set when the user stopped the command from grove. The agent is told so, or it
// reads the exit code as a failure or a timeout.
let stoppedByUser = false

let pending = ''
socket.on('data', (data) => {
  pending += data.toString('utf8')
  let newline = pending.indexOf('\n')
  while (newline >= 0) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    newline = pending.indexOf('\n')
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.type === 'interrupt') {
      stoppedByUser = true
      signalChild('SIGINT')
    }
  }
})

child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`)
  send({ type: 'exit', code: 127, signal: null })
  socket.end()
  process.exitCode = 127
})

child.on('close', (code, signal) => {
  if (stoppedByUser) process.stderr.write('\n[Stopped by the user with Ctrl+C in Grove.]\n')
  send({ type: 'exit', code, signal })
  socket.end()
  socket.unref()
  if (signal) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code === null ? 1 : code
})
