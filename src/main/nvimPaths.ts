// Path resolution for the vendored Neovim runtime. In dev the tarball is
// extracted under resources/nvim/dist by scripts/fetch-nvim.ts; packaged
// builds ship the same tree via electron-builder extraResources.

import { app } from 'electron'
import { existsSync } from 'node:fs'
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

export function nvimConfigHome(): string {
  return join(nvimRoot(), 'config')
}

export function nvimAvailable(): boolean {
  return existsSync(nvimBinary())
}

// XDG dirs for writable nvim state (shada, undo, swap, future plugins) under
// grove's userData — the container-free isolation recipe. The user's own
// ~/.config/nvim and ~/.local/share/nvim are never used.
export function nvimEnvOverlay(): Record<string, string> {
  const base = join(app.getPath('userData'), 'nvim')
  return {
    VIMRUNTIME: nvimRuntime(),
    XDG_CONFIG_HOME: nvimConfigHome(),
    XDG_DATA_HOME: join(base, 'data'),
    XDG_STATE_HOME: join(base, 'state'),
    XDG_CACHE_HOME: join(base, 'cache')
  }
}
