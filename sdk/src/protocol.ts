// Wire-level contract between Grove and plugins: the manifest schema and the
// RPC envelope spoken over the worker boundary. Single source of truth —
// main, renderer, and published SDK all import these types.
//
// Compatibility seam: keep this file small and additive. Breaking changes
// require bumping GROVE_API_VERSION's major.

export const GROVE_API_VERSION = '0.1.0'

// ── Permissions ─────────────────────────────────────────────────

export type PluginPermission =
  | 'workspace.read' // findFiles, readFile, readExcerpt, searchText
  | 'workspace.write' // writeFile, create/rename/delete
  | 'ai.prompt' // one-shot mediated agent prompts
  | 'ai.skills' // register skills injected into agent runs
  | 'ai.mcp' // register in-worker MCP tools bridged into agents
  | 'state' // plugin-scoped persisted storage
  | 'shell' // reserved, denied in v1
  | 'net' // reserved, denied in v1

export const PLUGIN_PERMISSIONS: PluginPermission[] = [
  'workspace.read',
  'workspace.write',
  'ai.prompt',
  'ai.skills',
  'ai.mcp',
  'state',
  'shell',
  'net'
]

// ── Activation ──────────────────────────────────────────────────

// 'onStartup' | 'onCommand:<id>' | 'onOverlay:<id>' | 'onPane:<id>' | 'onView:<id>'
export type ActivationEvent = string

const ACTIVATION_PREFIXES = ['onCommand:', 'onOverlay:', 'onPane:', 'onView:']

export function isValidActivationEvent(event: string): boolean {
  if (event === 'onStartup') return true
  return ACTIVATION_PREFIXES.some((prefix) => event.startsWith(prefix) && event.length > prefix.length)
}

// ── Contributions (data-only, registered before the worker starts) ──

export interface CommandContribution {
  id: string
  title: string
  group?: string
  keywords?: string
}

export interface KeybindingContribution {
  id: string
  // Canonical sequence grammar, e.g. "leader space", "ctrl+k ctrl+s".
  keys: string
  context?: string
  // Editor-style mode required for the binding (e.g. 'normal'); only fires
  // while the focused pane reports that mode.
  mode?: string
  group?: string
  description: string
  command: string
}

export interface OverlayContribution {
  id: string
  title: string
  placeholder?: string
  preview?: boolean
  multiSelect?: boolean
  debounceMs?: number
}

export interface SidebarContribution {
  id: string
  label: string
  // Icon font name resolved by the host (e.g. a phosphor icon id).
  icon: string
  order?: number
  command: string
}

export interface MenuContribution {
  id: string
  menuId: string
  label: string
  group?: string
  order?: number
  command: string
}

export interface StatusBarContribution {
  id: string
  align: 'left' | 'right'
  order?: number
  text?: string
  tooltip?: string
  command?: string
}

export interface PaneContribution {
  id: string
  title: string
}

export interface ViewContribution {
  id: string
  label: string
  order?: number
  // Serialized layout tree of pane type ids (see renderer layoutTree model).
  tree: unknown
}

export interface PluginContributions {
  commands?: CommandContribution[]
  keybindings?: KeybindingContribution[]
  overlays?: OverlayContribution[]
  sidebar?: SidebarContribution[]
  menu?: MenuContribution[]
  statusBar?: StatusBarContribution[]
  panes?: PaneContribution[]
  views?: ViewContribution[]
  // SettingsContribution['settings'] shape; validated by the settings provider.
  settings?: unknown[]
}

// ── Manifest ────────────────────────────────────────────────────

export interface PluginManifest {
  // ^[a-z0-9][a-z0-9._-]{1,63}$ — e.g. "grove.file-finder"
  id: string
  name: string
  version: string
  description?: string
  // Worker ESM bundle, relative to the plugin root — e.g. "dist/extension.js".
  entry: string
  engines?: { grove?: string }
  permissions?: PluginPermission[]
  activation?: ActivationEvent[]
  contributes?: PluginContributions
}

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export type ManifestValidation = { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] }

// Structural validation of a parsed manifest.json. Deliberately hand-rolled
// (no schema dependency); errors are human-readable for the plugins UI.
export function validateManifest(value: unknown): ManifestValidation {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['manifest must be a JSON object'] }
  }
  const manifest = value as Record<string, unknown>
  validateIdentity(manifest, errors)
  validateEntry(manifest, errors)
  validatePermissions(manifest, errors)
  validateActivation(manifest, errors)
  validateContributions(manifest, errors)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: manifest as unknown as PluginManifest }
}

function validateIdentity(manifest: Record<string, unknown>, errors: string[]): void {
  if (typeof manifest.id !== 'string' || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    errors.push('id must match ' + PLUGIN_ID_PATTERN.source)
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    errors.push('name must be a non-empty string')
  }
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
    errors.push('version must be a semver string')
  }
}

function validateEntry(manifest: Record<string, unknown>, errors: string[]): void {
  const entry = manifest.entry
  if (typeof entry !== 'string' || entry.length === 0) {
    errors.push('entry must be a non-empty relative path')
    return
  }
  if (entry.startsWith('/') || entry.includes('..')) {
    errors.push('entry must stay inside the plugin directory')
  }
}

function validatePermissions(manifest: Record<string, unknown>, errors: string[]): void {
  if (manifest.permissions === undefined) return
  if (!Array.isArray(manifest.permissions)) {
    errors.push('permissions must be an array')
    return
  }
  for (const permission of manifest.permissions) {
    if (PLUGIN_PERMISSIONS.includes(permission as PluginPermission)) continue
    errors.push(`unknown permission "${String(permission)}"`)
  }
}

function validateActivation(manifest: Record<string, unknown>, errors: string[]): void {
  if (manifest.activation === undefined) return
  if (!Array.isArray(manifest.activation)) {
    errors.push('activation must be an array')
    return
  }
  for (const event of manifest.activation) {
    if (typeof event === 'string' && isValidActivationEvent(event)) continue
    errors.push(`invalid activation event "${String(event)}"`)
  }
}

const CONTRIBUTION_KEYS = [
  'commands',
  'keybindings',
  'overlays',
  'sidebar',
  'menu',
  'statusBar',
  'panes',
  'views',
  'settings'
] as const

function validateContributions(manifest: Record<string, unknown>, errors: string[]): void {
  if (manifest.contributes === undefined) return
  const contributes = manifest.contributes
  if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) {
    errors.push('contributes must be an object')
    return
  }
  for (const [key, list] of Object.entries(contributes)) {
    if (!CONTRIBUTION_KEYS.includes(key as (typeof CONTRIBUTION_KEYS)[number])) {
      errors.push(`unknown contribution point "${key}"`)
      continue
    }
    if (!Array.isArray(list)) errors.push(`contributes.${key} must be an array`)
  }
  validateContributionIds(contributes as PluginContributions, errors)
}

function validateContributionIds(contributes: PluginContributions, errors: string[]): void {
  const lists: [string, { id?: unknown }[] | undefined][] = [
    ['commands', contributes.commands],
    ['keybindings', contributes.keybindings],
    ['overlays', contributes.overlays],
    ['sidebar', contributes.sidebar],
    ['menu', contributes.menu],
    ['statusBar', contributes.statusBar],
    ['panes', contributes.panes],
    ['views', contributes.views]
  ]
  for (const [key, list] of lists) {
    if (!Array.isArray(list)) continue
    const missing = list.some((item) => !item || typeof item.id !== 'string' || item.id.length === 0)
    if (missing) errors.push(`every contributes.${key} entry needs a string id`)
  }
}

// ── RPC envelope ────────────────────────────────────────────────

// Symmetric, both directions. Request ids are per-connection monotonic
// counters: the host uses even ids, the worker odd — no handshake needed.

export interface RpcError {
  message: string
  code?: 'permission-denied' | 'cancelled' | 'invalid' | 'internal'
}

export type RpcMessage =
  | { kind: 'request'; id: number; method: string; params: unknown; streaming?: boolean }
  | { kind: 'response'; id: number; result?: unknown; error?: RpcError }
  // Batch of items for a streaming request.
  | { kind: 'stream'; id: number; chunk: unknown }
  // Terminates a streaming request (with error for failure/cancellation).
  | { kind: 'end'; id: number; error?: RpcError }
  // Best-effort; the receiver must still reply with 'end'.
  | { kind: 'cancel'; id: number }
  // Fire-and-forget notification.
  | { kind: 'event'; channel: string; payload: unknown }
