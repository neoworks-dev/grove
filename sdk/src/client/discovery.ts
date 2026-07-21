// Socket discovery for external apps. Resolution order: explicit option →
// GROVE_SOCK (injected into Grove-spawned terminals) → the grove-api.json
// discovery file in the platform userData directory.

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface DiscoveryInfo {
  socketPath: string
  apiVersion: string
  pid: number
}

function userDataCandidates(): string[] {
  const home = homedir()
  const candidates: string[] = []
  // Electron userData is keyed by app name: 'grove' in dev, 'Grove' packaged.
  const names = ['grove', 'Grove']
  if (process.platform === 'darwin') {
    for (const name of names) candidates.push(join(home, 'Library', 'Application Support', name))
    return candidates
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    for (const name of names) candidates.push(join(appData, name))
    return candidates
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
  for (const name of names) candidates.push(join(configHome, name))
  return candidates
}

export function discoverSocket(): DiscoveryInfo | null {
  const fromEnv = process.env.GROVE_SOCK
  if (fromEnv) return { socketPath: fromEnv, apiVersion: 'unknown', pid: 0 }
  for (const dir of userDataCandidates()) {
    const discoveryFile = join(dir, 'grove-api.json')
    if (!existsSync(discoveryFile)) continue
    try {
      const info = JSON.parse(readFileSync(discoveryFile, 'utf8')) as DiscoveryInfo
      if (typeof info.socketPath === 'string') return info
    } catch {
      continue
    }
  }
  return null
}
