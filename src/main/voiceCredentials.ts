// The claude.ai sign-in that Claude Code keeps on disk, read so voice dictation
// can use the same account. Grove never writes it and never hands the token to
// the renderer: only the voice session in main reads it. Claude Code refreshes
// the token itself, so an expired one is reported rather than refreshed here.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The part of the sign-in dictation needs. */
export interface ClaudeSignIn {
  accessToken: string
}

/** Why there is no usable claude.ai sign-in, worded for the user to act on. */
export class VoiceSignInError extends Error {}

/** Reads the claude.ai access token from Claude Code's credentials file, refusing an expired one. */
export async function readClaudeSignIn(now: number = Date.now()): Promise<ClaudeSignIn> {
  const contents = await readCredentialsFile()
  const oauth = parseOauth(contents)
  if (oauth.expiresAt !== undefined && oauth.expiresAt <= now) {
    throw new VoiceSignInError('Claude sign-in has expired; run `claude /login` to renew it.')
  }
  return { accessToken: oauth.accessToken }
}

/** The file Claude Code writes its sign-in to, honouring CLAUDE_CONFIG_DIR as Claude Code does. */
function credentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, '.credentials.json')
}

/** Reads the credentials file, turning a missing file into a sign-in error and rethrowing anything else. */
async function readCredentialsFile(): Promise<string> {
  try {
    return await readFile(credentialsPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new VoiceSignInError(
        'Voice dictation needs a claude.ai sign-in; run `claude /login` first.'
      )
    }
    throw error
  }
}

/** The fields of Claude Code's credentials file this module reads; the rest belongs to Claude Code. */
interface CredentialsFile {
  claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown }
}

/** Pulls the claude.ai OAuth block out of the credentials file, failing when it has no usable token. */
function parseOauth(contents: string): { accessToken: string; expiresAt?: number } {
  const parsed: CredentialsFile = JSON.parse(contents)
  const oauth = parsed.claudeAiOauth
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken === '') {
    throw new VoiceSignInError(
      'Voice dictation needs a claude.ai sign-in; API keys are not accepted.'
    )
  }
  const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined
  return { accessToken: oauth.accessToken, expiresAt }
}
