// The debug adapters Grove can start, and how it finds them.
//
// A descriptor is what a launch.json `type` needs to become a running adapter:
// which executable, started how, and what to fill into a configuration the
// adapter would otherwise reject. Descriptors are contributed by plugins
// (src/main/debug/adapters/*), the same way agent harnesses are, so the list is
// whatever is mounted. An installed Mason DAP package nobody describes still
// gets a generic stdio descriptor from its catalog entry, so anything Mason
// installs is at least attemptable.
//
// Executables are looked up in Mason's bin directory first and then on PATH,
// so a system-wide `gdb` or `lldb-dap` works without installing anything.

import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { DebugAdapterInfo } from '../../shared/debug'
import type { MasonCatalogEntry } from './mason'

/** How a resolved adapter is reached. */
export type AdapterLaunch =
  /** Spawned, speaking DAP over its stdin and stdout. */
  | { kind: 'stdio'; command: string; args: string[] }
  /** Spawned as a server on `port`, then connected to. */
  | { kind: 'server'; command: string; args: string[]; host: string; port: number }
  /** Already running somewhere (launch.json `debugServer`); only connected to. */
  | { kind: 'socket'; host: string; port: number }

export interface DebugAdapterDescriptor {
  id: string
  label: string
  /** The launch.json `type` values this adapter serves. */
  types: string[]
  /** Languages it debugs, as Mason names them; shown in the UI. */
  languages: string[]
  /** The Mason package that provides it, for installing it on demand. */
  masonPackage?: string
  /** The executable's name, looked up in Mason's bin directory and on PATH. */
  executable: string
  /** How to start it, given where its executable is and a free port. */
  launch(executablePath: string, port: number): AdapterLaunch
  /**
   * Fills in what the adapter needs and launch.json may leave out (a default
   * console, a `type` it renamed). Gets a copy; returns the configuration to send.
   */
  resolveConfiguration?(
    configuration: Record<string, unknown>,
    context: AdapterContext
  ): Record<string, unknown>
  /**
   * A configuration that debugs this file on its own, offered beside the
   * project's launch.json; null for files the adapter has nothing to offer for.
   */
  currentFileConfiguration?(filePath: string): Record<string, unknown> | null
}

/** Where a configuration is being started, for adapters that look around it. */
export interface AdapterContext {
  worktreePath: string
  env: NodeJS.ProcessEnv
}

/** A descriptor together with where its executable was found. */
export interface ResolvedAdapter {
  descriptor: DebugAdapterDescriptor
  executablePath: string | null
}

export class DebugAdapterRegistry {
  private descriptors = new Map<string, DebugAdapterDescriptor>()
  private masonCatalog: MasonCatalogEntry[] = []

  /**
   * @param executableDirectories Where executables are looked for, in order:
   *   Mason's bin directory, then PATH. A function so the search follows
   *   PATH changes and a Mason install made after start-up.
   */
  constructor(private executableDirectories: () => string[] = defaultExecutableDirectories) {}

  /** Adds a descriptor. Returns the inverse, for a plugin's `ctx.effect`. */
  register(descriptor: DebugAdapterDescriptor): () => void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(`debug adapter already registered: ${descriptor.id}`)
    }
    this.descriptors.set(descriptor.id, descriptor)
    return () => {
      this.descriptors.delete(descriptor.id)
    }
  }

  /** Replaces the Mason catalog the generic descriptors are made from. */
  setMasonCatalog(catalog: MasonCatalogEntry[]): void {
    this.masonCatalog = catalog
  }

  /** Every descriptor: the registered ones, then one per undescribed Mason package. */
  list(): DebugAdapterDescriptor[] {
    const registered = [...this.descriptors.values()]
    const described = new Set(registered.map((descriptor) => descriptor.masonPackage))
    const generic = this.masonCatalog
      .filter((entry) => !described.has(entry.name) && entry.bins.length > 0)
      .map((entry) => genericMasonDescriptor(entry))
    return [...registered, ...generic]
  }

  /** The descriptor serving a launch.json `type`, or null when none does. */
  forType(type: string): DebugAdapterDescriptor | null {
    for (const descriptor of this.list()) {
      if (descriptor.types.includes(type)) {
        return descriptor
      }
    }
    return null
  }

  get(id: string): DebugAdapterDescriptor | null {
    for (const descriptor of this.list()) {
      if (descriptor.id === id) {
        return descriptor
      }
    }
    return null
  }

  /** A descriptor and where its executable is, null when it is not installed. */
  resolve(descriptor: DebugAdapterDescriptor): ResolvedAdapter {
    return { descriptor, executablePath: this.findExecutable(descriptor.executable) }
  }

  /** The listing the UI shows, with each adapter's executable looked up. */
  describe(installing: Set<string>): DebugAdapterInfo[] {
    return this.list().map((descriptor) => {
      let installKey = descriptor.id
      if (descriptor.masonPackage) {
        installKey = descriptor.masonPackage
      }
      return {
        id: descriptor.id,
        label: descriptor.label,
        types: descriptor.types,
        languages: descriptor.languages,
        executable: this.findExecutable(descriptor.executable),
        masonPackage: descriptor.masonPackage || null,
        installing: installing.has(installKey)
      }
    })
  }

  /** The first file called `name` in the search directories that can be run. */
  findExecutable(name: string): string | null {
    return findExecutableIn(this.executableDirectories(), name)
  }
}

/** The first file called `name` in `directories` that can be run, or null. */
export function findExecutableIn(directories: string[], name: string): string | null {
  for (const directory of directories) {
    const candidate = join(directory, name)
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }
  return null
}

/** PATH's directories, for a registry made without Mason (tests, a missing profile). */
function defaultExecutableDirectories(): string[] {
  return pathDirectories()
}

/** The directories on PATH, in order. */
export function pathDirectories(): string[] {
  const path = process.env.PATH || ''
  return path.split(delimiter).filter((directory) => directory !== '')
}

function isExecutableFile(path: string): boolean {
  if (!existsSync(path)) {
    return false
  }
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * A descriptor for a Mason DAP package Grove has no plugin for: its first
 * executable over stdio, serving the launch.json `type` named after the package.
 */
export function genericMasonDescriptor(entry: MasonCatalogEntry): DebugAdapterDescriptor {
  return {
    id: `mason:${entry.name}`,
    label: entry.name,
    types: [entry.name],
    languages: entry.languages,
    masonPackage: entry.name,
    executable: entry.bins[0],
    launch: (executablePath) => ({ kind: 'stdio', command: executablePath, args: [] })
  }
}
