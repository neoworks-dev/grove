// Output of the commands agents run, streamed so the user can watch them.
//
// Three parts: the hub that holds what each command printed and passes it on;
// the helper for harnesses that report everything-so-far rather than what is
// new; and Claude's prefix and tee, which must run every command exactly as it
// would have run while copying a Bash command's output to grove.

import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addedOutput, ShellOutputHub } from '../src/main/agents/shellOutput'
import { matchBashCall } from '../src/main/agents/harnesses/claudeShellTee'
import type { ShellOutputUpdate } from '../src/shared/agents'

const PREFIX = join(import.meta.dir, '..', 'resources', 'agent-shell', 'prefix.sh')

/** A hub that records what it publishes. */
function recordingHub(): { hub: ShellOutputHub; updates: ShellOutputUpdate[] } {
  const updates: ShellOutputUpdate[] = []
  return { hub: new ShellOutputHub((update) => updates.push(update)), updates }
}

describe('the output hub', () => {
  test('passes output on in batches, and says when the command is done', async () => {
    const { hub, updates } = recordingHub()
    const sink = hub.sinkFor('s1')

    sink.begin('t1')
    sink.append('t1', 'one\n')
    sink.append('t1', 'two\n')
    await Bun.sleep(80)
    sink.end('t1')

    expect(updates).toEqual([
      { sessionId: 's1', toolUseId: 't1', text: '', running: true },
      { sessionId: 's1', toolUseId: 't1', text: 'one\ntwo\n', running: true },
      { sessionId: 's1', toolUseId: 't1', text: '', running: false }
    ])
  })

  test('a view opening mid-run gets everything so far', () => {
    const { hub } = recordingHub()
    const sink = hub.sinkFor('s1')
    sink.begin('t1')
    sink.append('t1', 'building…\n')

    expect(hub.snapshot('s1')).toEqual([{ toolUseId: 't1', text: 'building…\n', running: true }])
    expect(hub.snapshot('s2')).toEqual([])
  })

  test('drops a command once its result is in and it has exited', () => {
    const { hub } = recordingHub()
    const sink = hub.sinkFor('s1')
    sink.begin('t1')
    sink.end('t1')

    hub.settle('s1', 't1')

    expect(hub.snapshot('s1')).toEqual([])
  })

  test('keeps a command sent to the background until it exits', () => {
    const { hub } = recordingHub()
    const sink = hub.sinkFor('s1')
    sink.begin('t1')

    hub.settle('s1', 't1')
    sink.append('t1', 'still going\n')

    expect(hub.snapshot('s1')).toEqual([{ toolUseId: 't1', text: 'still going\n', running: true }])
    sink.end('t1')
    expect(hub.snapshot('s1')).toEqual([])
  })

  test('interrupts a running command through the harness', () => {
    const { hub } = recordingHub()
    let interrupted = 0
    hub.sinkFor('s1').begin('t1', () => {
      interrupted += 1
    })

    expect(hub.interrupt('s1', 't1')).toBe(true)
    expect(hub.interrupt('s1', 'nope')).toBe(false)
    expect(interrupted).toBe(1)
  })
})

describe('output reported as everything so far', () => {
  test('passes on only what is new', () => {
    expect(addedOutput('', 'a\n')).toBe('a\n')
    expect(addedOutput('a\n', 'a\nb\n')).toBe('a\nb\n'.slice(2))
  })

  test('finds the new part after the front was trimmed', () => {
    const previous = `${'x'.repeat(400)}line 41\n`
    const next = `${'x'.repeat(250)}line 41\nline 42\n`
    expect(addedOutput(previous, next)).toBe('line 42\n')
  })
})

describe('matching a copied command to its call', () => {
  test('only an exact command matches', () => {
    const open = new Map([
      ['t1', 'bun test'],
      ['t2', 'ls']
    ])
    expect(matchBashCall(open, 'ls')).toBe('t2')
    expect(matchBashCall(open, 'ls -la')).toBeNull()
    expect(matchBashCall(new Map([['t1', 'bun test']]), 'bun run build')).toBeNull()
  })
})

// ── Claude's prefix and tee ───────────────────────────────────────

let directory: string | null = null
let server: Server | null = null

afterEach(async () => {
  server?.close()
  server = null
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = null
})

/** A stand-in for grove's socket: records every message, and can answer one. */
async function fakeGrove(
  onStart?: (socket: Socket) => void
): Promise<{ path: string; messages: unknown[] }> {
  directory = await mkdtemp(join(tmpdir(), 'grove-tee-'))
  const path = join(directory, 'shell.sock')
  const messages: unknown[] = []
  server = createServer((socket) => {
    let pending = ''
    socket.setEncoding('utf8')
    socket.on('data', (data: string) => {
      pending += data
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const message = JSON.parse(pending.slice(0, newline)) as { type: string }
        messages.push(message)
        if (message.type === 'start') onStart?.(socket)
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    })
  })
  await new Promise<void>((resolve) => server!.listen(path, resolve))
  return { path, messages }
}

/** Runs the prefix the way Claude Code does: the whole command line as one argument. */
function runPrefix(
  commandLine: string,
  socketPath: string | null
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.GROVE_SHELL_SOCKET
  // Claude Code's own environment never has it; only the prefix sets it, for the tee.
  delete env.ELECTRON_RUN_AS_NODE
  if (socketPath) {
    env.GROVE_SHELL_SOCKET = socketPath
    env.GROVE_NODE = process.execPath
    env.GROVE_SESSION_ID = 's1'
  }
  return new Promise((resolve) => {
    const child = spawn(PREFIX, [commandLine], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => (stdout += data))
    child.stderr.on('data', (data) => (stderr += data))
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

/** A command line in the shape Claude Code builds for its Bash tool. */
function claudeCommand(command: string): string {
  const quoted = command.replace(/'/g, "'\\''")
  return `source /nonexistent/snapshot-bash-1.sh 2>/dev/null || true && eval '${quoted}' < /dev/null && pwd -P >| /dev/null`
}

describe.skipIf(process.platform === 'win32')("Claude's shell prefix", () => {
  test('runs a Bash command unchanged and copies its output to grove', async () => {
    const grove = await fakeGrove()

    const result = await runPrefix(claudeCommand("echo out; echo 'it''s' >&2; exit 3"), grove.path)
    await Bun.sleep(50)

    expect(result).toEqual({ stdout: 'out\n', stderr: 'its\n', code: 3 })
    expect(grove.messages).toEqual([
      { type: 'start', sessionId: 's1', command: "echo out; echo 'it''s' >&2; exit 3" },
      { type: 'output', stream: 'stdout', text: 'out\n' },
      { type: 'output', stream: 'stderr', text: 'its\n' },
      { type: 'exit', code: 3, signal: null }
    ])
  })

  // The tee runs on grove's Electron as Node; a command that starts Electron
  // itself (`bun run qa start`) must not inherit that (#267).
  test("keeps the tee's ELECTRON_RUN_AS_NODE out of the command", async () => {
    const grove = await fakeGrove()

    const result = await runPrefix(claudeCommand('echo "${ELECTRON_RUN_AS_NODE-unset}"'), grove.path)

    expect(result.stdout).toBe('unset\n')
  })

  test('runs the command as before when grove is not listening', async () => {
    const result = await runPrefix(claudeCommand('echo alone'), null)

    expect(result).toEqual({ stdout: 'alone\n', stderr: '', code: 0 })
  })

  test('leaves hooks and servers alone', async () => {
    const grove = await fakeGrove()

    const result = await runPrefix('echo hook', grove.path)
    await Bun.sleep(50)

    expect(result).toEqual({ stdout: 'hook\n', stderr: '', code: 0 })
    expect(grove.messages).toEqual([])
  })

  test('stops the command when grove sends Ctrl+C', async () => {
    const grove = await fakeGrove((socket) => {
      setTimeout(() => socket.write(`${JSON.stringify({ type: 'interrupt' })}\n`), 100)
    })

    const started = Date.now()
    const result = await runPrefix(claudeCommand('sleep 5; echo finished'), grove.path)

    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.stdout).toBe('')
    // The agent is told the user stopped it, not left to guess at the exit code.
    expect(result.stderr).toContain('Stopped by the user')
  })
})
