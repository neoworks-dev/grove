// Plugin discovery + validation. Three roots, identical format everywhere:
//   builtin  <resources>/plugins (auto-trusted, auto-granted)
//   user     <userData>/plugins
//   project  <repo>/.workbench/plugins (requires one-time trust per version)

import { app } from 'electron'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { validateManifest, type PluginManifest } from '../../shared/plugins'
import type { PermissionBroker } from '../api/broker'

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

/** Where the built-in plugins live: the app's resources, or the repo's in development. */
export function builtinRoot(): string {
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
  // The load in flight, which the next one waits behind.
  private loading: Promise<unknown> = Promise.resolve()

  constructor(broker: PermissionBroker) {
    this.broker = broker
  }

  list(): PluginRecord[] {
    return [...this.records.values()]
  }

  get(id: string): PluginRecord | null {
    return this.records.get(id) ?? null
  }

  /**
   * Rediscovers every plugin, for no repository or for the one just opened.
   * Loads run one after another, so the last one asked for is what stays; and
   * the old records keep being served until the new set is complete, since a
   * worker may be importing its bundle through grove-plugin:// meanwhile.
   */
  loadAll(repoPath: string | null): Promise<PluginRecord[]> {
    const load = this.loading.then(() => this.loadInto(repoPath))
    this.loading = load.catch(() => undefined)
    return load
  }

  /** Discovers every root into a fresh map, then swaps it in whole. */
  private async loadInto(repoPath: string | null): Promise<PluginRecord[]> {
    this.repoPath = repoPath
    const records = new Map<string, PluginRecord>()
    await this.loadRoot(records, builtinRoot(), 'builtin')
    await this.loadRoot(records, userRoot(), 'user')
    if (repoPath) await this.loadRoot(records, projectRoot(repoPath), 'project')
    this.records = records
    return this.list()
  }

  /** Adds one root's plugins to `records`. */
  private async loadRoot(
    records: Map<string, PluginRecord>,
    root: string,
    source: PluginSource
  ): Promise<void> {
    for (const dir of await pluginDirs(root)) {
      const record = await this.loadOne(dir, source)
      if (!record) continue
      // Later roots never silently shadow earlier ones (builtin wins).
      if (records.has(record.id)) continue
      records.set(record.id, record)
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
