import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appStub, electronStub } from './electronStub'

// paths.ts reads electron's app at call time for userData, the app path and the
// packaged flag; all three are redirected per test.
let userDataPath = ''
let appPath = ''
let packaged = false
Object.defineProperty(appStub, 'isPackaged', { get: () => packaged, configurable: true })
appStub.getAppPath = () => appPath
appStub.getPath = () => userDataPath
mock.module('electron', () => electronStub)

const { nibLaunch, nibAvailable, nibSocketPath, nibDataDir } = await import('../src/main/nib/paths')

let sandbox = ''

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'grove-nib-paths-'))
  userDataPath = join(sandbox, 'userData')
  appPath = join(sandbox, 'app')
  packaged = false
  delete process.env.GROVE_NIB
})

afterEach(async () => {
  delete process.env.GROVE_NIB
  await rm(sandbox, { recursive: true, force: true })
})

/** A directory that looks enough like a nib checkout for the launch to resolve. */
async function fakeCheckout(name: string): Promise<string> {
  const checkout = join(sandbox, name)
  await mkdir(join(checkout, 'src'), { recursive: true })
  await writeFile(join(checkout, 'src', 'index.ts'), 'export {}\n')
  return checkout
}

describe('nibSocketPath', () => {
  it('uses the sock directory beside grove’s own socket', () => {
    expect(nibSocketPath()).toBe(join(userDataPath, 'sock', 'nib.sock'))
  })

  it('falls back to a short temp path when userData would blow the address limit', () => {
    userDataPath = join(sandbox, 'x'.repeat(120))
    const socketPath = nibSocketPath()

    // Past ~108 bytes a unix socket binds and then fails every connect, so the
    // fallback is the only thing keeping this working at all.
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(100)
    expect(socketPath.startsWith(tmpdir())).toBe(true)
  })

  it('gives one userData the same fallback every time, and two of them different ones', () => {
    const long = join(sandbox, 'y'.repeat(120))
    userDataPath = long
    const first = nibSocketPath()
    const second = nibSocketPath()
    userDataPath = join(sandbox, 'z'.repeat(120))

    expect(first).toBe(second)
    expect(nibSocketPath()).not.toBe(first)
  })
})

describe('nibLaunch', () => {
  it('runs the configured checkout through bun in development', async () => {
    const checkout = await fakeCheckout('nib-configured')

    expect(nibLaunch(checkout)).toEqual({
      command: 'bun',
      args: ['run', join(checkout, 'src', 'index.ts')],
      cwd: checkout,
      source: checkout
    })
  })

  it('lets GROVE_NIB override the configured checkout', async () => {
    const configured = await fakeCheckout('nib-configured')
    const override = await fakeCheckout('nib-override')
    process.env.GROVE_NIB = override

    expect(nibLaunch(configured)?.cwd).toBe(override)
  })

  it('reports nib as missing rather than launching a checkout that is not there', () => {
    expect(nibLaunch(join(sandbox, 'nowhere'))).toBeNull()
    expect(nibAvailable(join(sandbox, 'nowhere'))).toBe(false)
  })

  it('has no development fallback once packaged: the binary is there or it is not', async () => {
    // electron sets resourcesPath; under bun it has to be supplied.
    ;(process as { resourcesPath?: string }).resourcesPath = join(sandbox, 'resources')
    await fakeCheckout('nib-configured')
    packaged = true

    expect(nibLaunch(join(sandbox, 'nib-configured'))).toBeNull()
  })
})

describe('nibDataDir', () => {
  it('stays inside grove’s userData so an embedded nib never shares a user’s own state', () => {
    expect(nibDataDir()).toBe(join(userDataPath, 'nib'))
  })
})
