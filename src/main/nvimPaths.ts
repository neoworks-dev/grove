// Path resolution for the vendored Neovim runtime. In dev the tarball is
// extracted under resources/nvim/dist by scripts/fetch-nvim.ts; packaged
// builds ship the same tree via electron-builder extraResources.

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, symlink, lstat, realpath, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function nvimRoot(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'nvim')
  return join(app.getAppPath(), 'resources', 'nvim')
}

function distDir(): string {
  return join(nvimRoot(), 'dist', `${process.platform}-${process.arch}`)
}

export function nvimBinary(): string {
  const name = process.platform === 'win32' ? 'nvim.exe' : 'nvim'
  return join(distDir(), 'bin', name)
}

export function nvimRuntime(): string {
  return join(distDir(), 'share', 'nvim', 'runtime')
}

// The bundled grove-managed config source (committed in the repo, shipped in
// packaged builds). It is symlinked into the user config dir on first launch.
export function bundledNvimConfigDir(): string {
  return join(nvimRoot(), 'config', 'nvim')
}

// Grove's XDG_CONFIG_HOME: a user-visible config root at ~/.config/grove that
// holds a `nvim/` config. Kept outside the app so it can be inspected and
// hand-edited; the user's own ~/.config/nvim is never touched.
export function nvimConfigHome(): string {
  return join(homedir(), '.config', 'grove')
}

export function nvimUserConfigDir(): string {
  return join(nvimConfigHome(), 'nvim')
}

// Ensure ~/.config/grove/nvim is a symlink to the bundled grove config, so repo
// edits show up live. Anything else at that path (a broken link, a link to an
// older app install, a leftover real directory) shadows the bundled config: nvim
// then starts without `swapfile = false` and without the SwapExists answerer, and
// two panes on one file hit a blocking E325 prompt that stalls the RPC. So repair
// the path rather than leaving whatever is there untouched. Displaced entries are
// renamed, never deleted.
export async function ensureNvimUserConfig(): Promise<void> {
  const target = nvimUserConfigDir()
  await mkdir(nvimConfigHome(), { recursive: true })

  const existing = await lstat(target).catch(() => null)
  if (!existing) {
    await linkBundledNvimConfig(target)
    return
  }
  if (existing.isSymbolicLink() && (await pointsAtBundledNvimConfig(target))) return

  await moveNvimConfigAside(target)
  await linkBundledNvimConfig(target)
}

async function linkBundledNvimConfig(target: string): Promise<void> {
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(bundledNvimConfigDir(), target, linkType)
}

// Resolves both sides, so a link written with a different but equivalent path
// (or through a symlinked home) still counts as correct.
async function pointsAtBundledNvimConfig(target: string): Promise<boolean> {
  const linked = await realpath(target).catch(() => null)
  if (!linked) return false
  const bundled = await realpath(bundledNvimConfigDir()).catch(() => bundledNvimConfigDir())
  return linked === bundled
}

async function moveNvimConfigAside(target: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${target}.replaced-${stamp}`
  await rename(target, backup)
  console.warn(
    `[nvim] ${target} did not point at the bundled grove config; moved to ${backup} and relinked`
  )
}

export function nvimAvailable(): boolean {
  return existsSync(nvimBinary())
}

// XDG dirs for writable nvim state (shada, undo, swap, lazy plugins) under
// grove's userData — the container-free isolation recipe. The user's own
// ~/.config/nvim and ~/.local/share/nvim are never used. The writable base is
// deliberately not named "nvim": on Linux userData is ~/.config/grove, so that
// would collide with the config dir at ~/.config/grove/nvim.
export function nvimEnvOverlay(): Record<string, string> {
  const base = join(app.getPath('userData'), 'nvim-runtime')
  return {
    VIMRUNTIME: nvimRuntime(),
    XDG_CONFIG_HOME: nvimConfigHome(),
    XDG_DATA_HOME: join(base, 'data'),
    XDG_STATE_HOME: join(base, 'state'),
    XDG_CACHE_HOME: join(base, 'cache')
  }
}
