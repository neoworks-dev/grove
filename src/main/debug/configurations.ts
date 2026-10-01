// Launch configurations: the project's own `.vscode/launch.json` — the format
// VS Code, nvim-dap and most adapters' docs already use — plus one per adapter
// for the file open in the editor. Nothing is listed that one of those two did
// not produce.

import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import type { DebugConfigurationEntry } from '../../shared/debug'
import type { DebugAdapterDescriptor, DebugAdapterRegistry } from './registry'

/** launch.json's platform-specific override keys, by Node's platform name. */
const PLATFORM_KEYS: Record<string, string> = {
  linux: 'linux',
  darwin: 'osx',
  win32: 'windows'
}

/** What launch.json and the variables in it are resolved against. */
export interface ConfigurationContext {
  worktreePath: string
  /** The file open in the editor, absolute. */
  activeFile?: string
  /** 1-based cursor line in that file. */
  activeLine?: number
  env?: NodeJS.ProcessEnv
}

/** The configurations in a worktree's launch.json, or none when it has none. */
export async function readLaunchConfigurations(
  worktreePath: string
): Promise<Record<string, unknown>[]> {
  const path = join(worktreePath, '.vscode', 'launch.json')
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) {
    return []
  }
  return launchConfigurationsOf(text)
}

/** The configurations in launch.json's text, comments and trailing commas allowed. */
export function launchConfigurationsOf(text: string): Record<string, unknown>[] {
  const errors: ParseError[] = []
  const document: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
  if (!document || typeof document !== 'object') {
    return []
  }
  const configurations = (document as { configurations?: unknown }).configurations
  if (!Array.isArray(configurations)) {
    return []
  }
  return configurations
    .filter((entry): entry is Record<string, unknown> => isNamedConfiguration(entry))
    .map((entry) => withPlatformOverrides(entry))
}

function isNamedConfiguration(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') {
    return false
  }
  const configuration = entry as Record<string, unknown>
  return typeof configuration.name === 'string' && typeof configuration.type === 'string'
}

/** Merges the `linux`/`osx`/`windows` block for this platform over the rest. */
export function withPlatformOverrides(
  configuration: Record<string, unknown>,
  platform: string = process.platform
): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(configuration)) {
    if (Object.values(PLATFORM_KEYS).includes(key)) {
      continue
    }
    merged[key] = value
  }
  const override = configuration[PLATFORM_KEYS[platform]]
  if (override && typeof override === 'object') {
    Object.assign(merged, override)
  }
  return merged
}

/**
 * Every configuration that can be started in a worktree: launch.json's, then
 * each adapter's for the active file. Adapter readiness is looked up per entry.
 */
export async function listConfigurations(
  registry: DebugAdapterRegistry,
  context: ConfigurationContext
): Promise<DebugConfigurationEntry[]> {
  const fromLaunchJson = await readLaunchConfigurations(context.worktreePath)
  const entries = fromLaunchJson.map((configuration) =>
    entryOf(registry, configuration, 'launch.json')
  )
  if (!context.activeFile) {
    return entries
  }
  for (const descriptor of registry.list()) {
    const configuration = currentFileConfigurationOf(descriptor, context.activeFile)
    if (configuration) {
      entries.push(entryOf(registry, configuration, 'adapter'))
    }
  }
  return entries
}

function currentFileConfigurationOf(
  descriptor: DebugAdapterDescriptor,
  filePath: string
): Record<string, unknown> | null {
  if (!descriptor.currentFileConfiguration) {
    return null
  }
  return descriptor.currentFileConfiguration(filePath)
}

function entryOf(
  registry: DebugAdapterRegistry,
  configuration: Record<string, unknown>,
  source: DebugConfigurationEntry['source']
): DebugConfigurationEntry {
  const name = String(configuration.name)
  const type = String(configuration.type)
  let request: DebugConfigurationEntry['request'] = 'launch'
  if (configuration.request === 'attach') {
    request = 'attach'
  }
  const descriptor = registry.forType(type)
  let adapterReady = typeof configuration.debugServer === 'number'
  let installPackage: string | null = null
  if (descriptor && !adapterReady) {
    adapterReady = registry.resolve(descriptor).executablePath !== null
    if (!adapterReady && descriptor.masonPackage) {
      installPackage = descriptor.masonPackage
    }
  }
  let adapterId: string | null = null
  if (descriptor) {
    adapterId = descriptor.id
  }
  return {
    key: `${source}:${name}`,
    name,
    type,
    request,
    source,
    configuration,
    adapterId,
    adapterReady,
    installPackage
  }
}

/**
 * Replaces VS Code's predefined variables (`${workspaceFolder}`, `${file}`,
 * `${env:NAME}`, …) everywhere in a configuration. Variables Grove cannot
 * resolve — `${command:…}`, `${input:…}` — are left as written, and reported.
 */
export function substituteVariables(
  configuration: Record<string, unknown>,
  context: ConfigurationContext
): { configuration: Record<string, unknown>; unresolved: string[] } {
  const values = variableValues(context)
  const unresolved = new Set<string>()
  const environment = context.env || process.env
  const replace = (text: string): string =>
    text.replace(/\$\{([^}]+)\}/g, (placeholder, name: string) => {
      if (name.startsWith('env:')) {
        return environment[name.slice(4)] || ''
      }
      if (name in values) {
        return values[name]
      }
      unresolved.add(placeholder)
      return placeholder
    })
  const substituted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(configuration)) {
    substituted[key] = mapStrings(value, replace)
  }
  return { configuration: substituted, unresolved: [...unresolved] }
}

function variableValues(context: ConfigurationContext): Record<string, string> {
  const values: Record<string, string> = {
    workspaceFolder: context.worktreePath,
    workspaceRoot: context.worktreePath,
    workspaceFolderBasename: basename(context.worktreePath),
    cwd: context.worktreePath,
    pathSeparator: sep,
    '/': sep
  }
  const file = context.activeFile
  if (!file) {
    return values
  }
  const extension = extname(file)
  values.file = file
  values.fileBasename = basename(file)
  values.fileExtname = extension
  values.fileBasenameNoExtension = basename(file, extension)
  values.fileDirname = dirname(file)
  values.fileDirnameBasename = basename(dirname(file))
  values.relativeFile = relative(context.worktreePath, file)
  values.relativeFileDirname = relative(context.worktreePath, dirname(file))
  if (context.activeLine !== undefined) {
    values.lineNumber = String(context.activeLine)
  }
  return values
}

/** A deep copy of a JSON value with every string passed through `replace`. */
function mapStrings(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === 'string') {
    return replace(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, replace))
  }
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      copy[key] = mapStrings(item, replace)
    }
    return copy
  }
  return value
}
