import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  symlink,
  readlink,
  readdir,
  rm,
  realpath
} from 'node:fs/promises'
import * as nodeOs from 'node:os'
import { join } from 'node:path'
import { appStub, electronStub } from './electronStub'

// nvimPaths derives the config root from os.homedir() and the bundled config from
// app.getAppPath(); both are redirected into a temp tree per test. Stubbing
// homedir (not $HOME — bun's homedir does not read it) keeps the test away from
// the developer's real ~/.config/grove.
let appRoot = ''
let testHome = ''
appStub.getAppPath = () => appRoot
appStub.getPath = () => appRoot
mock.module('electron', () => electronStub)
mock.module('node:os', () => ({ ...nodeOs, homedir: () => testHome }))

const { ensureNvimUserConfig, ensureCopilotConfigLink, nvimUserConfigDir, bundledNvimConfigDir } =
  await import('../src/main/nvimPaths')

let sandbox = ''

beforeEach(async () => {
  sandbox = await mkdtemp(join(nodeOs.tmpdir(), 'grove-nvim-config-'))
  appRoot = join(sandbox, 'app')
  testHome = join(sandbox, 'home')
  await mkdir(groveConfigRoot(), { recursive: true })
  await mkdir(bundledNvimConfigDir(), { recursive: true })
  await writeFile(join(bundledNvimConfigDir(), 'init.lua'), 'vim.opt.swapfile = false\n')
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

function groveConfigRoot(): string {
  return join(testHome, '.config', 'grove')
}

async function linkTarget(): Promise<string> {
  return realpath(await readlink(nvimUserConfigDir()))
}

async function backupNames(): Promise<string[]> {
  const entries = await readdir(groveConfigRoot())
  return entries.filter((entry) => entry.startsWith('nvim.replaced-'))
}

// The bundled config carries `swapfile = false` and the SwapExists answerer. If
// anything else occupies ~/.config/grove/nvim, nvim starts without them and two
// panes on one file hit a blocking E325 prompt — so the path gets repaired.
describe('ensureNvimUserConfig', () => {
  it('links the bundled config when nothing is there', async () => {
    await ensureNvimUserConfig()
    expect(await linkTarget()).toBe(await realpath(bundledNvimConfigDir()))
  })

  it('leaves an already-correct link alone', async () => {
    await ensureNvimUserConfig()
    await ensureNvimUserConfig()
    expect(await linkTarget()).toBe(await realpath(bundledNvimConfigDir()))
    expect(await backupNames()).toEqual([])
  })

  it('replaces a broken link', async () => {
    await symlink(join(sandbox, 'gone'), nvimUserConfigDir(), 'dir')
    await ensureNvimUserConfig()
    expect(await linkTarget()).toBe(await realpath(bundledNvimConfigDir()))
  })

  it('replaces a link pointing at another install', async () => {
    const stale = join(sandbox, 'old-install', 'config', 'nvim')
    await mkdir(stale, { recursive: true })
    await symlink(stale, nvimUserConfigDir(), 'dir')
    await ensureNvimUserConfig()
    expect(await linkTarget()).toBe(await realpath(bundledNvimConfigDir()))
  })

  it('moves a real directory aside instead of deleting it', async () => {
    await mkdir(nvimUserConfigDir(), { recursive: true })
    await writeFile(join(nvimUserConfigDir(), 'init.lua'), '-- leftover\n')
    await ensureNvimUserConfig()

    expect(await linkTarget()).toBe(await realpath(bundledNvimConfigDir()))
    const backups = await backupNames()
    expect(backups).toHaveLength(1)
    const moved = join(groveConfigRoot(), backups[0], 'init.lua')
    expect(await readFile(moved, 'utf8')).toBe('-- leftover\n')
  })
})

function globalCopilotConfigDir(): string {
  return join(testHome, '.config', 'github-copilot')
}

function groveCopilotConfigDir(): string {
  return join(groveConfigRoot(), 'github-copilot')
}

async function writeGlobalCopilotAuth(): Promise<void> {
  await mkdir(globalCopilotConfigDir(), { recursive: true })
  await writeFile(join(globalCopilotConfigDir(), 'apps.json'), '{"github.com":{}}\n')
}

// copilot.lua reads $XDG_CONFIG_HOME/github-copilot, which grove repoints at
// ~/.config/grove. Without the link an already-signed-in user faces a second
// `:Copilot auth` inside grove.
describe('ensureCopilotConfigLink', () => {
  it("links grove's copilot config at the user's real one", async () => {
    await writeGlobalCopilotAuth()
    await ensureCopilotConfigLink()

    const linked = join(groveCopilotConfigDir(), 'apps.json')
    expect(await readFile(linked, 'utf8')).toBe('{"github.com":{}}\n')
  })

  it('does nothing when the user has no global copilot config', async () => {
    await ensureCopilotConfigLink()
    await expect(readlink(groveCopilotConfigDir())).rejects.toThrow()
  })

  it('leaves a grove-local copilot directory alone', async () => {
    await writeGlobalCopilotAuth()
    await mkdir(groveCopilotConfigDir(), { recursive: true })
    await writeFile(join(groveCopilotConfigDir(), 'apps.json'), '{"grove-only":{}}\n')

    await ensureCopilotConfigLink()

    const kept = join(groveCopilotConfigDir(), 'apps.json')
    expect(await readFile(kept, 'utf8')).toBe('{"grove-only":{}}\n')
  })

  it('is idempotent across launches', async () => {
    await writeGlobalCopilotAuth()
    await ensureCopilotConfigLink()
    await ensureCopilotConfigLink()

    expect(await realpath(await readlink(groveCopilotConfigDir()))).toBe(
      await realpath(globalCopilotConfigDir())
    )
  })
})
