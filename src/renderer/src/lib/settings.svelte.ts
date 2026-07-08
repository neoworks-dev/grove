// Reactive settings provider. Schemas are registered here (base app via
// baseSettings.ts, plugins via the SDK); raw values mirror the two JSON files
// owned by the main process. Resolution: project value ?? user value ??
// schema default.

import type {
  SettingDefinition,
  SettingScope,
  SettingsContribution,
  SettingsSnapshot
} from '../../../shared/settings'

type ChangeCallback = (value: unknown) => void

class SettingsStore {
  contributions = $state<SettingsContribution[]>([])
  userValues = $state<Record<string, unknown>>({})
  projectValues = $state<Record<string, unknown>>({})
  ready = $state(false)

  private subscribers = new Map<string, Set<ChangeCallback>>()

  // Register (or replace by contributor id) a settings schema. Keys must be
  // namespaced by the contributor id so plugins can never collide.
  registerSchemas(contribution: SettingsContribution): () => void {
    const prefix = `${contribution.contributorId}.`
    const invalid = contribution.settings.filter((setting) => !setting.key.startsWith(prefix))
    if (invalid.length > 0) {
      const keys = invalid.map((setting) => setting.key).join(', ')
      throw new Error(`settings keys must start with "${prefix}": ${keys}`)
    }
    const others = this.contributions.filter(
      (entry) => entry.contributorId !== contribution.contributorId
    )
    this.contributions = [...others, contribution]
    return () => {
      this.contributions = this.contributions.filter(
        (entry) => entry.contributorId !== contribution.contributorId
      )
    }
  }

  definition(key: string): SettingDefinition | null {
    for (const contribution of this.contributions) {
      const found = contribution.settings.find((setting) => setting.key === key)
      if (found) return found
    }
    return null
  }

  // Effective value: project ?? user ?? schema default. Reactive — reading
  // this in a component tracks both value maps and the schema list.
  get<T>(key: string): T {
    if (key in this.projectValues) return this.projectValues[key] as T
    if (key in this.userValues) return this.userValues[key] as T
    return this.definition(key)?.default as T
  }

  // Raw value in one scope (for the preferences pane), no fallback.
  raw(key: string, scope: SettingScope): unknown {
    const values = scope === 'user' ? this.userValues : this.projectValues
    return values[key]
  }

  // Optimistic write: update local state, then persist via IPC. `undefined`
  // clears the key in that scope.
  async set(key: string, value: unknown, scope: SettingScope): Promise<void> {
    const previous = this.snapshotEffective()
    this.applyScope(key, value, scope)
    this.notifyChanged(previous)
    try {
      await window.workbench.settings.set(key, value, scope)
    } catch (error) {
      console.warn('settings: failed to persist', key, error)
    }
  }

  // Plain (non-rune) subscription for bridging to plugin workers.
  onChange(key: string, callback: ChangeCallback): () => void {
    const set = this.subscribers.get(key) ?? new Set()
    set.add(callback)
    this.subscribers.set(key, set)
    return () => {
      set.delete(callback)
    }
  }

  async init(): Promise<void> {
    const snapshot = await window.workbench.settings.read()
    this.applySnapshot(snapshot)
    window.workbench.on('event:settings-changed', (payload) => {
      const previous = this.snapshotEffective()
      this.applySnapshot(payload as SettingsSnapshot)
      this.notifyChanged(previous)
    })
    this.ready = true
  }

  private applySnapshot(snapshot: SettingsSnapshot): void {
    this.userValues = snapshot.user ?? {}
    this.projectValues = snapshot.project ?? {}
  }

  private applyScope(key: string, value: unknown, scope: SettingScope): void {
    const values = scope === 'user' ? { ...this.userValues } : { ...this.projectValues }
    if (value === undefined) delete values[key]
    else values[key] = value
    if (scope === 'user') this.userValues = values
    else this.projectValues = values
  }

  private snapshotEffective(): Map<string, unknown> {
    const effective = new Map<string, unknown>()
    for (const key of this.subscribers.keys()) effective.set(key, this.get(key))
    return effective
  }

  private notifyChanged(previous: Map<string, unknown>): void {
    for (const [key, callbacks] of this.subscribers) {
      const value = this.get(key)
      if (previous.get(key) === value) continue
      for (const callback of callbacks) callback(value)
    }
  }
}

export const settings = new SettingsStore()
