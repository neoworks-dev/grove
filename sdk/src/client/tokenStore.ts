// Default persistence for pairing tokens: one file per app id under the
// user's config dir, mode 600. Apps that want custom storage pass
// onPairingToken/token to connectGrove instead.

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

function tokenDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'grove', 'tokens')
}

function tokenPath(appId: string): string {
  return join(tokenDir(), appId)
}

export function loadToken(appId: string): string | undefined {
  try {
    const token = readFileSync(tokenPath(appId), 'utf8').trim()
    if (token.length > 0) return token
    return undefined
  } catch {
    return undefined
  }
}

export function saveToken(appId: string, token: string): void {
  mkdirSync(tokenDir(), { recursive: true, mode: 0o700 })
  writeFileSync(tokenPath(appId), token, { encoding: 'utf8', mode: 0o600 })
  chmodSync(tokenPath(appId), 0o600)
}
