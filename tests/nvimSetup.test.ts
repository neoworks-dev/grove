import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appStub, electronStub } from './electronStub'

// First-run setup runs the bundled nvim headless once and records a stamp. The
// app root is a temp tree holding a fake `nvim` script, so no real nvim runs
// and nothing outside the sandbox is touched.
let appRoot = ''
appStub.getAppPath = () => appRoot
appStub.getPath = () => join(appRoot, 'userData')
mock.module('electron', () => electronStub)

const distBin = (): string =>
  join(appRoot, 'resources', 'nvim', 'dist', `${process.platform}-${process.arch}`, 'bin')
const stampPath = (): string => join(appRoot, 'userData', 'nvim-runtime', 'data', 'grove-setup')

/** Writes a fake nvim that prints the given stderr and exits with the code. */
async function fakeNvim(stderr: string, exitCode: number): Promise<void> {
  await mkdir(distBin(), { recursive: true })
  const script = `#!/bin/sh\nprintf '${stderr}' >&2\nexit ${exitCode}\n`
  await writeFile(join(distBin(), 'nvim'), script)
  await chmod(join(distBin(), 'nvim'), 0o755)
}

// setUpNvimProfile rather than ensureNvimSetup: the latter runs at most once
// per process, and each test needs its own run.
const { setUpNvimProfile, stepFromLine } = await import('../src/main/nvimSetup')

beforeEach(async () => {
  appRoot = await mkdtemp(join(tmpdir(), 'grove-nvim-setup-'))
  const configDir = join(appRoot, 'resources', 'nvim', 'config', 'nvim')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'init.lua'), '-- config\n')
})

afterEach(async () => {
  await rm(appRoot, { recursive: true, force: true })
})

describe('stepFromLine', () => {
  it('reads a step marker and ignores other output', async () => {
    expect(stepFromLine('grove-setup: Installing syntax parsers')).toBe('Installing syntax parsers')
    expect(stepFromLine('[nvim-treesitter/install/lua]: Downloading')).toBeNull()
    expect(stepFromLine('grove-setup: ')).toBeNull()
  })
})

describe('setUpNvimProfile', () => {
  it('reports each step and stamps the config once setup succeeds', async () => {
    await fakeNvim('noise\\ngrove-setup: Downloading the completion engine\\n', 0)
    const steps: (string | null)[] = []
    await setUpNvimProfile((step) => steps.push(step))
    expect(steps).toEqual(['Installing plugins', 'Downloading the completion engine', null])
    expect((await readFile(stampPath(), 'utf8')).length).toBe(64)
  })

  it('leaves no stamp when setup fails, so the next launch retries', async () => {
    await fakeNvim('grove-setup failed: Installing syntax parsers\\n', 1)
    await setUpNvimProfile(() => {})
    expect(await readFile(stampPath(), 'utf8').catch(() => null)).toBeNull()
  })

  it('skips setup when the stamp matches the config', async () => {
    await fakeNvim('', 0)
    await setUpNvimProfile(() => {})
    // A second nvim that would fail: it must not run at all.
    await fakeNvim('', 1)
    const steps: (string | null)[] = []
    await setUpNvimProfile((step) => steps.push(step))
    expect(steps).toEqual([])
  })
})
