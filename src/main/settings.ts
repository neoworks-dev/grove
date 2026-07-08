// Schema-free settings persistence: two human-editable JSON files with flat
// dotted keys. User scope lives in the app-data dir, project scope inside the
// repo's .workbench directory (project overrides user; resolution against
// schema defaults happens renderer-side where the schemas live).

import { app } from 'electron'
import { watch, type FSWatcher } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { SettingScope, SettingsSnapshot } from '../shared/settings'

const WATCH_DEBOUNCE_MS = 150
// Ignore watcher events fired right after our own writes.
const SELF_WRITE_GRACE_MS = 500

interface SettingsEvents {
  onChange: (snapshot: SettingsSnapshot) => void
}

function userSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function projectSettingsPath(repoPath: string): string {
  return join(repoPath, '.workbench', 'settings.json')
}

async function readValues(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

export class SettingsService {
  private events: SettingsEvents
  private userValues: Record<string, unknown> = {}
  private projectValues: Record<string, unknown> = {}
  private repoPath: string | null = null
  private watchers: FSWatcher[] = []
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private lastWriteAt = 0

  constructor(events: SettingsEvents) {
    this.events = events
  }

  async loadUser(): Promise<void> {
    this.userValues = await readValues(userSettingsPath())
    this.watchDir(dirname(userSettingsPath()), 'settings.json')
  }

  async attachRepo(repoPath: string): Promise<void> {
    this.detachRepo()
    this.repoPath = repoPath
    this.projectValues = await readValues(projectSettingsPath(repoPath))
    // Watch the directory (not the file) so the file appearing later is seen.
    this.watchDir(join(repoPath, '.workbench'), 'settings.json')
  }

  detachRepo(): void {
    this.repoPath = null
    this.projectValues = {}
    // Rebuild watchers with only the user-scope one.
    this.closeWatchers()
    this.watchDir(dirname(userSettingsPath()), 'settings.json')
  }

  snapshot(): SettingsSnapshot {
    return { user: { ...this.userValues }, project: { ...this.projectValues } }
  }

  // Read-modify-write preserving unknown keys; `undefined` deletes the key.
  async set(key: string, value: unknown, scope: SettingScope): Promise<SettingsSnapshot> {
    const path = this.pathFor(scope)
    if (!path) throw new Error('no repository open for project-scope settings')
    const values = await readValues(path)
    if (value === undefined) delete values[key]
    else values[key] = value
    await mkdir(dirname(path), { recursive: true })
    this.lastWriteAt = Date.now()
    await writeFile(path, JSON.stringify(values, null, 2) + '\n', 'utf8')
    if (scope === 'user') this.userValues = values
    else this.projectValues = values
    return this.snapshot()
  }

  openPath(scope: SettingScope): string | null {
    return this.pathFor(scope)
  }

  close(): void {
    this.closeWatchers()
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
  }

  private pathFor(scope: SettingScope): string | null {
    if (scope === 'user') return userSettingsPath()
    if (!this.repoPath) return null
    return projectSettingsPath(this.repoPath)
  }

  private watchDir(dir: string, fileName: string): void {
    try {
      const watcher = watch(dir, (_event, changed) => {
        if (changed && changed !== fileName) return
        this.scheduleReload()
      })
      this.watchers.push(watcher)
    } catch {
      // Directory may not exist yet (.workbench before first write) — the
      // first settings:set creates it; external edits before then are moot.
    }
  }

  private scheduleReload(): void {
    if (Date.now() - this.lastWriteAt < SELF_WRITE_GRACE_MS) return
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => void this.reload(), WATCH_DEBOUNCE_MS)
  }

  private async reload(): Promise<void> {
    const user = await readValues(userSettingsPath())
    const project = this.repoPath ? await readValues(projectSettingsPath(this.repoPath)) : {}
    const changed =
      JSON.stringify(user) !== JSON.stringify(this.userValues) ||
      JSON.stringify(project) !== JSON.stringify(this.projectValues)
    if (!changed) return
    this.userValues = user
    this.projectValues = project
    this.events.onChange(this.snapshot())
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
  }
}
