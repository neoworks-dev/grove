// The shell behind the composer's `!`: what it captures, what it reports, and
// what it does with a command that never finishes.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShellCommand } from '../src/main/agents/shell'

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
      const result = await runShellCommand('echo hello', { cwd })
      expect(result.output.trim()).toBe('hello')
      expect(result.exitCode).toBe(0)
      expect(result.outcome).toBe('exit 0')
    })
  })

  test('stderr is part of the output and a failure keeps its code', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('echo out; echo bad 1>&2; exit 3', { cwd })
      expect(result.output).toContain('out')
      expect(result.output).toContain('bad')
      expect(result.exitCode).toBe(3)
      expect(result.outcome).toBe('exit 3')
    })
  })

  test('the command runs in the directory it was given', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('pwd', { cwd })
      expect(result.output).toContain(cwd.split('/').pop() as string)
    })
  })

  test('a command reading stdin sees EOF rather than hanging', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('cat', { cwd, timeoutMs: 2_000 })
      expect(result.outcome).toBe('exit 0')
    })
  })

  test('long output keeps its tail and says what was dropped', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('printf "abcdefghij"', { cwd, maxOutputChars: 4 })
      expect(result.output).toBe('[6 earlier characters dropped]\nghij')
    })
  })

  test('a command that never finishes is killed and reported as timed out', async () => {
    await inTempDir(async (cwd) => {
      const result = await runShellCommand('sleep 30', { cwd, timeoutMs: 200 })
      expect(result.outcome).toBe('timed out after 200ms')
      expect(result.exitCode).not.toBe(0)
    })
  })
})
