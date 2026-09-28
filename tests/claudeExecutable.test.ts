// Which Claude Code binary the harness hands the SDK. In a packaged build the
// SDK's own lookup lands inside app.asar, which cannot be spawned (ENOTDIR), so
// the path has to point at electron-builder's unpacked copy.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bundledExecutable,
  resolveClaudeExecutable,
  unpackedFromAsar
} from '../src/main/agents/claudeExecutable'

describe('unpackedFromAsar', () => {
  test('moves a path inside app.asar to app.asar.unpacked', () => {
    const packaged =
      '/tmp/.mount_grove/resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'
    expect(unpackedFromAsar(packaged)).toBe(
      '/tmp/.mount_grove/resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'
    )
  })

  test('leaves a path outside any asar alone', () => {
    const development = '/home/me/grove/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'
    expect(unpackedFromAsar(development)).toBe(development)
  })
})

describe('resolveClaudeExecutable', () => {
  const originalPath = process.env.PATH

  afterEach(() => {
    process.env.PATH = originalPath
  })

  test('prefers a claude on PATH over the bundled CLI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'grove-claude-'))
    const system = join(directory, 'claude')
    writeFileSync(system, '#!/bin/sh\n')
    chmodSync(system, 0o755)
    process.env.PATH = directory

    expect(resolveClaudeExecutable()).toBe(system)
  })

  test('falls back to the bundled CLI when PATH has none', () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), 'grove-empty-'))

    const bundled = bundledExecutable()
    if (bundled === null) {
      expect(resolveClaudeExecutable()).toBeUndefined()
      return
    }
    expect(resolveClaudeExecutable()).toBe(bundled)
    expect(existsSync(bundled)).toBe(true)
  })
})
