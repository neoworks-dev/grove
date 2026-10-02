// The shell behind the composer's `!`: what it captures, what it reports, and
// what it does with a command that never finishes.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShellCommand, startShellCommand } from '../src/main/agents/shell'
import { spawnOnPipes } from '../src/main/agents/commandTerminal'

async function inTempDir<T>(use: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'grove-shell-'))
  try {
    return await use(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('runShellCommand', () => {
  test('output and exit code come back from a command that worked', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('echo hello', { spawn: spawnOnPipes, cwd })
      expect(result.output.trim()).toBe('hello')
      expect(result.exitCode).toBe(0)
      expect(result.outcome).toBe('exit 0')
    })
  })

  test('stderr is part of the output and a failure keeps its code', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('echo out; echo bad 1>&2; exit 3', { spawn: spawnOnPipes, cwd })
      expect(result.output).toContain('out')
      expect(result.output).toContain('bad')
      expect(result.exitCode).toBe(3)
      expect(result.outcome).toBe('exit 3')
    })
  })

  test('the command runs in the directory it was given', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('pwd', { spawn: spawnOnPipes, cwd })
      expect(result.output).toContain(cwd.split('/').pop() as string)
    })
  })

  test('a command reading input waits for it, and can be typed into', async () => {
    await inTempDir(async (cwd) => {
      const running = startShellCommand('read answer; echo "got $answer"', { spawn: spawnOnPipes, cwd })
      running.write('yes\n')
      const result = await running.result
      expect(result.output).toBe('got yes')
      expect(result.outcome).toBe('exit 0')
    })
  })

  test('long output keeps its tail and says what was dropped', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('printf "abcdefghij"', { spawn: spawnOnPipes, cwd, maxOutputChars: 4 })
      expect(result.output).toBe('[6 earlier characters dropped]\nghij')
    })
  })

  test('a command that never finishes is killed and reported as timed out', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('sleep 30', { spawn: spawnOnPipes, cwd, timeoutMs: 200 })
      expect(result.outcome).toBe('timed out after 200ms')
      expect(result.exitCode).not.toBe(0)
    })
  })
})

describe('startShellCommand', () => {
  test('streams what the command prints as it prints it', async () => {
    await inTempDir(async (cwd) => {
      const seen: string[] = []
      const running = startShellCommand('echo one; echo two', { spawn: spawnOnPipes, cwd, onOutput: (text) => seen.push(text) })
      await running.result
      expect(seen.join('')).toBe('one\ntwo\n')
    })
  })

  test('sent to the background, a command outlives its time limit', async () => {
    await inTempDir(async (cwd) => {
      const running = startShellCommand('sleep 0.4; echo survived', { spawn: spawnOnPipes, cwd, timeoutMs: 200 })
      running.background()
      const result = await running.result
      expect(result.output.trim()).toBe('survived')
      expect(result.outcome).toBe('exit 0')
    })
  })

  test('interrupting stops what the command started too', async () => {
    await inTempDir(async (cwd) => {
      const running = startShellCommand('sleep 30; echo after', { spawn: spawnOnPipes, cwd })
      await Bun.sleep(100)
      running.interrupt()
      const result = await running.result
      expect(result.output).not.toContain('after')
    })
  })
})
