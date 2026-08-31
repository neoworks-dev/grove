// How the harnesses find the runtimes they drive.
//
// Both of these used to be where a harness quietly went missing: Claude reported
// itself unavailable whenever the SDK's bundled CLI was not installed, and Codex
// had no way to enumerate models at all. The two pieces below are what replaced
// that — a PATH lookup, and the framing of the app-server's JSON-RPC stream.

import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { executableOnPath } from '../src/main/agents/harnesses/claude'
import { readJsonLines } from '../src/main/agents/harnesses/codex'

/** Run a body with PATH replaced, and put the real one back afterwards. */
async function withPath(directories: string[], body: () => void | Promise<void>): Promise<void> {
  const original = process.env.PATH
  process.env.PATH = directories.join(delimiter)
  try {
    await body()
  } finally {
    process.env.PATH = original
  }
}

describe('executableOnPath', () => {
  test('finds an executable and reports its full path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'grove-path-'))
    const executable = join(directory, 'claude')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)

    await withPath([directory], () => {
      expect(executableOnPath('claude')).toBe(executable)
    })
  })

  test('ignores a file that is not executable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'grove-path-'))
    await writeFile(join(directory, 'claude'), 'not a program')
    await chmod(join(directory, 'claude'), 0o644)

    await withPath([directory], () => {
      expect(executableOnPath('claude')).toBeNull()
    })
  })

  test('reports null rather than throwing when there is nothing to find', async () => {
    await withPath([join(tmpdir(), 'grove-path-does-not-exist')], () => {
      expect(executableOnPath('claude')).toBeNull()
    })
  })
})

describe('readJsonLines', () => {
  test('reassembles messages split across chunks', () => {
    const stream = new PassThrough()
    const seen: unknown[] = []
    readJsonLines(stream, (message) => seen.push(message))

    stream.write('{"id":1,"res')
    stream.write('ult":{"ok":true}}\n{"id":2}\n')

    expect(seen).toEqual([{ id: 1, result: { ok: true } }, { id: 2 }])
  })

  test('skips the diagnostics the server interleaves with protocol messages', () => {
    const stream = new PassThrough()
    const seen: unknown[] = []
    readJsonLines(stream, (message) => seen.push(message))

    stream.write('starting up\n\n{"id":2}\n')

    expect(seen).toEqual([{ id: 2 }])
  })
})
