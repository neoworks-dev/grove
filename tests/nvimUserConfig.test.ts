import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
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

const { ensureCopilotConfigLink, nvimConfigArgs, bundledNvimConfigDir } =
  await import('../src/main/nvimPaths')

let sandbox = ''
// The suite runs with XDG_CONFIG_HOME unset, so the config root falls back to
// the stubbed home; the profile test sets it for itself.
const inheritedXdgConfigHome = process.env.XDG_CONFIG_HOME

/** Puts XDG_CONFIG_HOME back the way it was, unset included. */
function restoreXdgConfigHome(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.XDG_CONFIG_HOME
    return
  }
  process.env.XDG_CONFIG_HOME = value
}

beforeEach(async () => {
  delete process.env.XDG_CONFIG_HOME
  sandbox = await mkdtemp(join(nodeOs.tmpdir(), 'grove-nvim-config-'))
  appRoot = join(sandbox, 'app')
  testHome = join(sandbox, 'home')
  await mkdir(groveConfigRoot(), { recursive: true })
  await mkdir(bundledNvimConfigDir(), { recursive: true })
  await writeFile(join(bundledNvimConfigDir(), 'init.lua'), 'vim.opt.swapfile = false\n')
})

afterEach(async () => {
  restoreXdgConfigHome(inheritedXdgConfigHome)
  await rm(sandbox, { recursive: true, force: true })
})

function groveConfigRoot(): string {
  return join(testHome, '.config', 'grove')
}

// Every Grove on the machine shares ~/.config/grove. A config linked in there
// was whichever install started last, so each launch relinked it and left an
// nvim.replaced-* behind, and an AppImage's link dangled once it exited. nvim
// is told which config to load instead.
describe('nvimConfigArgs', () => {
  it("loads this install's bundled init.lua", () => {
    expect(nvimConfigArgs()).toEqual(['-u', join(bundledNvimConfigDir(), 'init.lua')])
  })

  it('leaves the shared config root alone', async () => {
    await mkdir(join(groveConfigRoot(), 'nvim'), { recursive: true })
    await writeFile(join(groveConfigRoot(), 'nvim', 'init.lua'), '-- another install\n')

    nvimConfigArgs()
    await ensureCopilotConfigLink()

    expect(await readdir(groveConfigRoot())).toEqual(['nvim'])
    const kept = join(groveConfigRoot(), 'nvim', 'init.lua')
    expect(await readFile(kept, 'utf8')).toBe('-- another install\n')
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
