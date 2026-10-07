// Debug adapters from Mason, the package manager in the bundled nvim config.
//
// Mason keeps its whole registry as one JSON file under its data directory,
// with a `categories` list per package; the ones tagged "DAP" are the adapters
// it can install. Reading that file is how Grove knows what exists without a
// list of its own. Installing goes through the editor's own nvim profile, run
// headless (see GROVE_MASON_INSTALL in lua/grove/provision.lua), so the package lands where
// the editor's other Mason tools are.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One DAP package in Mason's registry. */
export interface MasonCatalogEntry {
  name: string
  languages: string[]
  /** The executables it links into Mason's bin directory. */
  bins: string[]
}

/** The registry fields Grove reads; everything else is ignored. */
interface RegistryPackage {
  name?: unknown
  categories?: unknown
  languages?: unknown
  bin?: unknown
}

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** Mason's directory inside the editor's data home. */
export function masonRoot(nvimDataHome: string): string {
  return join(nvimDataHome, 'nvim', 'mason')
}

export function masonBinDirectory(root: string): string {
  return join(root, 'bin')
}

/** Whether Mason has a package installed. */
export function masonPackageInstalled(root: string, name: string): boolean {
  return existsSync(join(root, 'packages', name))
}

/**
 * Every DAP package in the registries Mason has downloaded, installed or not.
 * Empty until Mason has fetched a registry at least once.
 */
export async function readMasonDebugCatalog(root: string): Promise<MasonCatalogEntry[]> {
  const files = await registryFiles(join(root, 'registries'))
  const entries = new Map<string, MasonCatalogEntry>()
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) {
      continue
    }
    for (const entry of debugEntriesOf(text)) {
      if (!entries.has(entry.name)) {
        entries.set(entry.name, entry)
      }
    }
  }
  return [...entries.values()]
}

/** The DAP packages in one registry.json's text. */
export function debugEntriesOf(registryText: string): MasonCatalogEntry[] {
  let packages: unknown
  try {
    packages = JSON.parse(registryText)
  } catch {
    return []
  }
  if (!Array.isArray(packages)) {
    return []
  }
  const entries: MasonCatalogEntry[] = []
  for (const candidate of packages as RegistryPackage[]) {
    const entry = debugEntryOf(candidate)
    if (entry) {
      entries.push(entry)
    }
  }
  return entries
}

function debugEntryOf(candidate: RegistryPackage): MasonCatalogEntry | null {
  if (typeof candidate.name !== 'string') {
    return null
  }
  if (!Array.isArray(candidate.categories) || !candidate.categories.includes('DAP')) {
    return null
  }
  return {
    name: candidate.name,
    languages: stringsOf(candidate.languages),
    bins: binNamesOf(candidate.bin)
  }
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function binNamesOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  return Object.keys(value)
}

/** Every registry.json under Mason's registries directory, however deep it nests them. */
async function registryFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 4) {
    return []
  }
  const children = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const child of children) {
    const path = join(directory, child.name)
    if (child.isDirectory()) {
      files.push(...(await registryFiles(path, depth + 1)))
    } else if (child.name === 'registry.json') {
      files.push(path)
    }
  }
  return files
}

/** What running the editor's nvim headless takes: its binary, arguments and environment. */
export interface HeadlessNvim {
  binary: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Installs one Mason package with the editor's nvim profile, run headless.
 * Resolves once it is installed; rejects with what nvim printed when it is not.
 */
export function installMasonPackage(nvim: HeadlessNvim, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(nvim.binary, ['--headless', ...nvim.args], {
      env: { ...nvim.env, GROVE_MASON_INSTALL: name },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const output: string[] = []
    const timeout = setTimeout(() => child.kill('SIGKILL'), INSTALL_TIMEOUT_MS)
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(installFailureMessage(name, output.join(''))))
    })
  })
}

/** Why an install failed: the last lines nvim printed, when it printed any. */
function installFailureMessage(name: string, printed: string): string {
  const detail = printed.trim().split('\n').slice(-5).join('\n')
  if (detail === '') {
    return `installing ${name} failed`
  }
  return `installing ${name} failed: ${detail}`
}
