// Path resolution for the vendored Neovim runtime. In dev the tarball is
// extracted under resources/nvim/dist by scripts/fetch-nvim.ts; packaged
// builds ship the same tree via electron-builder extraResources.

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, symlink, lstat, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

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
// packaged builds). nvim loads it through nvimConfigArgs().
export function bundledNvimConfigDir(): string {
  return join(nvimRoot(), 'config', 'nvim')
}

// nvim's XDG_CONFIG_HOME: ~/.config/grove, so the user's own ~/.config/nvim is
// never touched. It holds the copilot link below. It follows the app's own
// XDG_CONFIG_HOME, so an isolated profile (qa, e2e) keeps it inside the profile.
export function nvimConfigHome(): string {
  let configRoot = process.env.XDG_CONFIG_HOME
  if (!configRoot) {
    configRoot = join(homedir(), '.config')
  }
  return join(configRoot, 'grove')
}

/**
 * nvim's arguments for loading this install's bundled config.
 *
 * Named on the command line rather than linked into $XDG_CONFIG_HOME/nvim: that
 * path is shared by every Grove on the machine (the dev checkout, each
 * worktree, every AppImage launch at its own mount point), so a link there was
 * whichever install started last, and dangled once an AppImage exited.
 */
export function nvimConfigArgs(): string[] {
  return ['-u', join(bundledNvimConfigDir(), 'init.lua')]
}

// Copilot keeps its device-flow token under $XDG_CONFIG_HOME/github-copilot.
// Grove repoints nvim's XDG_CONFIG_HOME at nvimConfigHome(), so copilot.lua would look
// at a fresh directory and demand a second `:Copilot auth` from users already
// signed in for their own nvim. Link grove's path at the real one so a single
// login serves both. No global config means no link: copilot.lua then creates
// its own directory on first auth and grove stays self-contained.
export async function ensureCopilotConfigLink(): Promise<void> {
  const globalConfig = join(homedir(), '.config', 'github-copilot')
  if (!existsSync(globalConfig)) return
  await removeSelfLink(globalConfig)

  const target = join(nvimConfigHome(), 'github-copilot')
  // Anything already at the path wins — a real directory there holds a grove-only
  // login that replacing would sign the user out of. A link that loops is ours
  // and broken, so it is replaced.
  const existing = await lstat(target).catch(() => null)
  if (existing && !(existing.isSymbolicLink() && (await isLoopingLink(target)))) return
  if (existing) await unlink(target)

  await mkdir(nvimConfigHome(), { recursive: true })
  // A link made inside the directory it points at is a loop that crawlers
  // (language servers' file watchers) descend into until ELOOP.
  if (await isWithin(nvimConfigHome(), globalConfig)) {
    console.warn(`[nvim] not linking ${target}: it would sit inside ${globalConfig}`)
    return
  }
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  try {
    await symlink(globalConfig, target, linkType)
  } catch (error) {
    console.warn(`[nvim] could not link ${target} at ${globalConfig}:`, error)
  }
}

/**
 * Removes a `github-copilot` link inside the user's copilot config that points
 * back at that config — left by an earlier link made inside its own target.
 */
async function removeSelfLink(globalConfig: string): Promise<void> {
  const selfLink = join(globalConfig, 'github-copilot')
  const stats = await lstat(selfLink).catch(() => null)
  if (!stats || !stats.isSymbolicLink()) return
  if (!(await resolvesTo(selfLink, globalConfig)) && !(await isLoopingLink(selfLink))) return
  console.warn(`[nvim] removing self-referencing link ${selfLink}`)
  await unlink(selfLink)
}

/** Whether `path` resolves to the same place as `directory`. */
async function resolvesTo(path: string, directory: string): Promise<boolean> {
  const resolvedPath = await realpath(path).catch(() => null)
  return resolvedPath === (await realpath(directory))
}

/** Whether resolving the link at `path` never ends. */
async function isLoopingLink(path: string): Promise<boolean> {
  try {
    await realpath(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ELOOP'
  }
}

/** Whether `path` is `directory` or somewhere beneath it, links resolved. */
async function isWithin(path: string, directory: string): Promise<boolean> {
  const resolvedPath = await realpath(path)
  const resolvedDirectory = await realpath(directory)
  if (resolvedPath === resolvedDirectory) return true
  return resolvedPath.startsWith(resolvedDirectory + sep)
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
    REAL_XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    REAL_XDG_DATA_HOME: process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    REAL_XDG_STATE_HOME: process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    REAL_XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    XDG_CONFIG_HOME: nvimConfigHome(),
    XDG_DATA_HOME: join(base, 'data'),
    XDG_STATE_HOME: join(base, 'state'),
    XDG_CACHE_HOME: join(base, 'cache')
  }
}
