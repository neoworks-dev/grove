// Which Claude Code CLI the Agent SDK is told to spawn. Kept apart from the
// harness so the plugin AI bridge can share it without loading the harness.

import { accessSync, constants, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, sep } from 'node:path'

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/**
 * Which Claude Code executable the SDK should spawn, or `undefined` when there
 * is none and the SDK should report that itself.
 *
 * The SDK ships the CLI as per-platform optional dependencies and refuses to
 * start when none of them is installed — which is what any install that skipped
 * optional packages leaves behind, and it surfaces as the whole harness being
 * unavailable. Grove looks those packages up itself and, when none is there,
 * falls back to a `claude` on PATH so a system install serves just as well.
 *
 * The bundled one is always named rather than left to the SDK: in a packaged
 * build the SDK resolves it inside `app.asar`, which cannot be spawned.
 */
export function resolveClaudeExecutable(): string | undefined {
  const bundled = bundledExecutable()
  if (bundled !== null) {
    return unpackedFromAsar(bundled)
  }
  return executableOnPath('claude') ?? undefined
}

/**
 * The on-disk copy of a path inside an asar archive.
 *
 * Electron reads files out of `app.asar` transparently, but a process can only
 * be spawned from a real file. electron-builder unpacks executables beside the
 * archive, into `app.asar.unpacked`, under the same relative path.
 */
export function unpackedFromAsar(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

/**
 * The CLI shipped inside one of the SDK's per-platform packages.
 *
 * The names are read off the SDK's own `optionalDependencies` rather than
 * rebuilt from `process.platform`, so grove does not have to track how the SDK
 * names its targets: only the package for this platform is ever installed, so
 * the first one that resolves is the right one.
 */
export function bundledExecutable(): string | null {
  const require = createRequire(__filename)
  for (const name of platformPackages(require)) {
    for (const entry of ['claude', 'claude.exe']) {
      try {
        return require.resolve(`${name}/${entry}`)
      } catch {
        continue
      }
    }
  }
  return null
}

interface SdkManifest {
  optionalDependencies?: Record<string, string>
}

function platformPackages(require: NodeJS.Require): string[] {
  try {
    // The SDK's `exports` map does not expose package.json, so it is read off
    // disk next to the entry point the resolver does hand back.
    const packageRoot = dirname(require.resolve(SDK_PACKAGE))
    const manifest = readJson<SdkManifest>(join(packageRoot, 'package.json'))
    if (!manifest.optionalDependencies) return []
    return Object.keys(manifest.optionalDependencies)
  } catch {
    return []
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The first executable of that name on PATH, or null when there is none. */
export function executableOnPath(name: string): string | null {
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const directory of directories) {
    for (const candidate of candidateNames(name)) {
      const full = join(directory, candidate)
      try {
        accessSync(full, constants.X_OK)
        return full
      } catch {
        continue
      }
    }
  }
  return null
}

/** Windows spells its executables with an extension; nothing else does. */
function candidateNames(name: string): string[] {
  if (process.platform !== 'win32') return [name]
  return [`${name}.cmd`, `${name}.exe`]
}
