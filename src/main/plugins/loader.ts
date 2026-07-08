// Plugin discovery + validation. Three roots, identical format everywhere:
//   builtin  <resources>/plugins (auto-trusted, auto-granted)
//   user     <userData>/plugins
//   project  <repo>/.workbench/plugins (requires one-time trust per version)

import { app } from 'electron'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { validateManifest, type PluginManifest } from '../../shared/plugins'
import type { PermissionBroker } from './broker'

export type PluginSource = 'builtin' | 'user' | 'project'

// 'blocked' = project plugin awaiting trust; 'invalid' = manifest errors.
export type PluginStatus = 'ready' | 'disabled' | 'blocked' | 'invalid'

export interface PluginRecord {
  id: string
  manifest: PluginManifest
  source: PluginSource
  root: string
  status: PluginStatus
  errors: string[]
}

function builtinRoot(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'plugins')
  return join(app.getAppPath(), 'resources', 'plugins')
}

function userRoot(): string {
  return join(app.getPath('userData'), 'plugins')
}

function projectRoot(repoPath: string): string {
  return join(repoPath, '.workbench', 'plugins')
}

async function pluginDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

export class PluginRegistry {
  private records = new Map<string, PluginRecord>()
  private broker: PermissionBroker
  private repoPath: string | null = null

  constructor(broker: PermissionBroker) {
    this.broker = broker
  }

  list(): PluginRecord[] {
    return [...this.records.values()]
  }

  get(id: string): PluginRecord | null {
    return this.records.get(id) ?? null
  }

  async loadAll(repoPath: string | null): Promise<PluginRecord[]> {
    this.repoPath = repoPath
    this.records.clear()
    await this.loadRoot(builtinRoot(), 'builtin')
    await this.loadRoot(userRoot(), 'user')
    if (repoPath) await this.loadRoot(projectRoot(repoPath), 'project')
    return this.list()
  }

  private async loadRoot(root: string, source: PluginSource): Promise<void> {
    for (const dir of await pluginDirs(root)) {
      const record = await this.loadOne(dir, source)
      if (!record) continue
      // Later roots never silently shadow earlier ones (builtin wins).
      if (this.records.has(record.id)) continue
      this.records.set(record.id, record)
    }
  }

  private async loadOne(dir: string, source: PluginSource): Promise<PluginRecord | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    } catch {
      return null // no manifest — not a plugin dir
    }
    const validation = validateManifest(parsed)
    if (!validation.ok) {
      const manifest = { id: dir.split('/').pop() ?? dir, name: dir, version: '0.0.0', entry: '' }
      return {
        id: manifest.id,
        manifest: manifest as PluginManifest,
        source,
        root: dir,
        status: 'invalid',
        errors: validation.errors
      }
    }
    const manifest = validation.manifest
    const status = await this.statusFor(manifest, source)
    return { id: manifest.id, manifest, source, root: dir, status, errors: [] }
  }

  private async statusFor(manifest: PluginManifest, source: PluginSource): Promise<PluginStatus> {
    if (!(await this.broker.isEnabled(manifest.id))) return 'disabled'
    if (source !== 'project') return 'ready'
    if (!this.repoPath) return 'blocked'
    const trusted = await this.broker.isProjectPluginTrusted(this.repoPath, manifest)
    return trusted ? 'ready' : 'blocked'
  }

  // Re-evaluate one record's status (after trust/enable changes).
  async refresh(id: string): Promise<PluginRecord | null> {
    const record = this.records.get(id)
    if (!record) return null
    if (record.status === 'invalid') return record
    record.status = await this.statusFor(record.manifest, record.source)
    return record
  }
}
