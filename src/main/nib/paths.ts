// Where the nib agent server comes from. Packaged builds ship a compiled binary
// via electron-builder extraResources, the same way the Neovim runtime does; in
// development it runs from a sibling checkout through bun, so changes to nib are
// picked up by restarting grove rather than rebuilding anything.

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// How to start the server: a command line and the directory to run it from.
export interface NibLaunch {
  command: string
  args: string[]
  cwd: string
  // The checkout or binary this resolves to, for error messages.
  source: string
}

function packagedBinary(): string {
  const name = process.platform === 'win32' ? 'nib-server.exe' : 'nib-server'
  return join(process.resourcesPath, 'nib', 'dist', `${process.platform}-${process.arch}`, name)
}

/**
 * The nib source checkout used in development. `configuredPath` comes from the
 * `workbench.nibPath` setting; GROVE_NIB overrides it for one-off runs.
 */
function sourceCheckout(configuredPath?: string): string {
  const configured = process.env.GROVE_NIB || configuredPath
  if (configured) return resolve(configured)
  return join(app.getAppPath(), '..', 'neoworks', 'nib')
}

/** The command line for the nib server, or null when it is not installed. */
export function nibLaunch(configuredPath?: string): NibLaunch | null {
  if (app.isPackaged) {
    const binary = packagedBinary()
    if (!existsSync(binary)) return null
    return { command: binary, args: [], cwd: homedir(), source: binary }
  }

  const checkout = sourceCheckout(configuredPath)
  const entry = join(checkout, 'src', 'index.ts')
  if (!existsSync(entry)) return null
  return { command: 'bun', args: ['run', entry], cwd: checkout, source: checkout }
}

export function nibAvailable(configuredPath?: string): boolean {
  return nibLaunch(configuredPath) !== null
}

/**
 * Where nib keeps sessions, extensions and per-project memory. Scoped to grove's
 * userData rather than ~/.nib so the embedded server never shares state with a
 * nib the user runs themselves.
 */
export function nibDataDir(): string {
  return join(app.getPath('userData'), 'nib')
}

/** Grove-owned extensions, copied into the data dir where nib always trusts them. */
export function bundledNibExtensionsDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'nib', 'extensions')
  return join(app.getAppPath(), 'resources', 'nib', 'extensions')
}

// A unix socket address is a fixed-size struct field; anything past ~108 bytes
// is silently rejected with EINVAL at connect time, long after bind appeared to
// succeed. Leave headroom rather than finding out at runtime.
const MAX_SOCKET_PATH = 100

/**
 * The socket nib listens on. Normally the 0700 `sock/` directory grove already
 * creates for its own plugin API socket; a userData path long enough to blow the
 * address limit falls back to a hashed name under the temp dir, which is short
 * by construction.
 */
export function nibSocketPath(): string {
  const userData = app.getPath('userData')
  const preferred = join(userData, 'sock', 'nib.sock')
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred

  const hash = createHash('sha256').update(userData).digest('hex').slice(0, 12)
  return join(tmpdir(), `grove-nib-${hash}.sock`)
}
