// Which Claude Code binary the harness hands the SDK. In a packaged build the
// SDK's own lookup lands inside app.asar, which cannot be spawned (ENOTDIR), so
// the path has to point at electron-builder's unpacked copy.

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolveClaudeExecutable, unpackedFromAsar } from '../src/main/agents/claudeExecutable'

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
  test('names the bundled CLI rather than leaving the lookup to the SDK', () => {
    const executable = resolveClaudeExecutable()
    expect(executable).toBeDefined()
    expect(existsSync(executable as string)).toBe(true)
  })
})
