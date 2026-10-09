// Reading the claude.ai sign-in Claude Code keeps on disk. Each test points
// CLAUDE_CONFIG_DIR at its own temp directory, so the real sign-in is never read.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClaudeSignIn, VoiceSignInError } from '../src/main/voiceCredentials'

let configDir = ''
let previousConfigDir: string | undefined

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'grove-voice-credentials-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

/** Writes a credentials file with the given contents into the test's config directory. */
async function writeCredentials(contents: unknown): Promise<void> {
  await writeFile(join(configDir, '.credentials.json'), JSON.stringify(contents))
}

describe('readClaudeSignIn', () => {
  test('returns the access token of an unexpired claude.ai sign-in', async () => {
    await writeCredentials({
      claudeAiOauth: { accessToken: 'sk-ant-oat-test', expiresAt: 2_000_000_000_000 }
    })

    const signIn = await readClaudeSignIn(1_000_000_000_000)

    expect(signIn.accessToken).toBe('sk-ant-oat-test')
  })

  test('refuses an expired sign-in and says how to renew it', async () => {
    await writeCredentials({ claudeAiOauth: { accessToken: 'old', expiresAt: 1_000 } })

    const attempt = readClaudeSignIn(2_000)

    await expect(attempt).rejects.toBeInstanceOf(VoiceSignInError)
    await expect(attempt).rejects.toThrow('claude /login')
  })

  test('refuses when there is no credentials file', async () => {
    await expect(readClaudeSignIn()).rejects.toBeInstanceOf(VoiceSignInError)
  })

  test('refuses a file with only an API key, which the endpoint does not accept', async () => {
    await writeCredentials({ primaryApiKey: 'sk-ant-api-test' })

    await expect(readClaudeSignIn()).rejects.toThrow('claude.ai sign-in')
  })

  test('accepts a sign-in without an expiry', async () => {
    await writeCredentials({ claudeAiOauth: { accessToken: 'no-expiry' } })

    const signIn = await readClaudeSignIn()

    expect(signIn.accessToken).toBe('no-expiry')
  })
})
