// "Connect Chrome" (#358): the native-messaging host installed per browser into
// a temporary home, never the user's own browser directories.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BrowserHostInstaller,
  NATIVE_HOST_NAME,
  extensionIdOf,
  type BrowserHostInstallerOptions
} from '../src/main/browserHostInstaller'

const shippedExtension = join(import.meta.dir, '..', 'resources', 'chrome-extension')

let directory: string
let options: BrowserHostInstallerOptions

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grove-host-installer-'))
  const hostScript = join(directory, 'shipped', 'host.cjs')
  await mkdir(join(directory, 'shipped'), { recursive: true })
  await writeFile(hostScript, 'process.stdout.write(JSON.stringify(process.env.GROVE_API_DISCOVERY) + process.argv.slice(2).join(","))')
  options = {
    platform: 'linux',
    home: join(directory, 'home'),
    configHome: join(directory, 'home', '.config'),
    userData: join(directory, 'home', '.config', 'Grove'),
    electronBinary: process.execPath,
    hostScript,
    extensionSource: shippedExtension
  }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** The manifest the installer wrote for a browser, parsed. */
function manifestAt(path: string): { name: string; path: string; type: string; allowed_origins: string[] } {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('installing the host', () => {
  test('nothing is installed until asked', async () => {
    const status = await new BrowserHostInstaller(options).status()
    expect(status.supported).toBe(true)
    expect(status.browsers.map((browser) => browser.installed)).toEqual([false, false, false, false])
    expect(status.extensionCopied).toBe(false)
    expect(existsSync(join(options.configHome, 'google-chrome'))).toBe(false)
  })

  test('installing for Chrome writes its manifest, allowing only Grove’s extension', async () => {
    const installer = new BrowserHostInstaller(options)
    const status = await installer.install('chrome')
    const manifestPath = join(options.configHome, 'google-chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
    const manifest = manifestAt(manifestPath)
    expect(manifest.name).toBe(NATIVE_HOST_NAME)
    expect(manifest.type).toBe('stdio')
    expect(manifest.path).toBe(installer.launcherPath)
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${status.extensionId}/`])
    expect(status.browsers.filter((browser) => browser.installed).map((browser) => browser.id)).toEqual(['chrome'])
    expect(existsSync(join(options.configHome, 'chromium'))).toBe(false)
  })

  test('each browser’s manifest goes in that browser’s directory', async () => {
    const installer = new BrowserHostInstaller(options)
    await installer.install('chromium')
    await installer.install('edge')
    await installer.install('brave')
    for (const directoryName of ['chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser']) {
      expect(existsSync(join(options.configHome, directoryName, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`))).toBe(true)
    }
  })

  test('on macOS the manifests live under Application Support', async () => {
    const installer = new BrowserHostInstaller({ ...options, platform: 'darwin' })
    await installer.install('chrome')
    const expected = join(options.home, 'Library', 'Application Support', 'Google/Chrome', 'NativeMessagingHosts')
    expect(existsSync(join(expected, `${NATIVE_HOST_NAME}.json`))).toBe(true)
  })

  test('installing copies the host and the extension into Grove’s userData', async () => {
    const installer = new BrowserHostInstaller(options)
    const status = await installer.install('chrome')
    expect(status.extensionCopied).toBe(true)
    expect(status.extensionPath).toBe(join(options.userData, 'browser-extension', 'extension'))
    expect(readFileSync(join(status.extensionPath, 'manifest.json'), 'utf8')).toBe(
      readFileSync(join(shippedExtension, 'manifest.json'), 'utf8')
    )
    expect(existsSync(join(options.userData, 'browser-extension', 'host.cjs'))).toBe(true)
  })

  test('the launcher runs the host on Grove’s binary as Node, pointed at this Grove', async () => {
    const installer = new BrowserHostInstaller(options)
    await installer.install('chrome')
    expect(statSync(installer.launcherPath).mode & 0o111).not.toBe(0)
    const launcher = readFileSync(installer.launcherPath, 'utf8')
    expect(launcher).toContain('export ELECTRON_RUN_AS_NODE=1')
    expect(launcher).toContain(`export GROVE_BROWSER_TOKEN='${join(options.userData, 'browser-extension', 'token')}'`)
    // Run as Chrome would, with the extension's origin as its argument.
    const run = spawnSync(installer.launcherPath, ['chrome-extension://id/'], { encoding: 'utf8' })
    expect(run.stdout).toBe(`${JSON.stringify(join(options.userData, 'grove-api.json'))}chrome-extension://id/`)
  })

  test('a path with a quote in it survives the launcher', async () => {
    const userData = join(directory, "it's grove")
    const installer = new BrowserHostInstaller({ ...options, userData })
    await installer.install('chrome')
    const run = spawnSync(installer.launcherPath, [], { encoding: 'utf8' })
    expect(run.stdout).toBe(JSON.stringify(join(userData, 'grove-api.json')))
  })

  test('removing deletes only that browser’s manifest', async () => {
    const installer = new BrowserHostInstaller(options)
    await installer.install('chrome')
    await installer.install('brave')
    const status = await installer.remove('chrome')
    expect(status.browsers.filter((browser) => browser.installed).map((browser) => browser.id)).toEqual(['brave'])
    expect(existsSync(join(options.configHome, 'google-chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`))).toBe(false)
  })

  test('refreshing re-copies an installed host, and installs nothing otherwise', async () => {
    const installer = new BrowserHostInstaller(options)
    await installer.refresh()
    expect(existsSync(installer.installDirectory)).toBe(false)
    await installer.install('chrome')
    await writeFile(join(installer.installDirectory, 'host.cjs'), 'stale')
    await installer.refresh()
    expect(readFileSync(join(installer.installDirectory, 'host.cjs'), 'utf8')).not.toBe('stale')
  })

  test('Windows is refused rather than half-installed', async () => {
    const installer = new BrowserHostInstaller({ ...options, platform: 'win32' })
    expect((await installer.status()).supported).toBe(false)
    await expect(installer.install('chrome')).rejects.toThrow('only supported on Linux and macOS')
  })
})

describe('the extension’s id', () => {
  test('comes from the key pinned in its manifest, as Chromium derives it', () => {
    // The key of Chrome's native-messaging sample, whose id its docs put in allowed_origins.
    const key =
      'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDcBHwzDvyBQ6bDppkIs9MP4ksKqCMyXQ/A52JivHZKh4YO/9vJsT3oaYhSpDCE9RPocOEQvwsHsFReW2nUEc6OLLyoCFFxIb7KkLGsmfakkut/fFdNJYh0xOTbSN8YvLWcqph09XAY2Y/f0AL7vfO1cuCqtkMt8hFrBGWxDdf9CQIDAQAB'
    expect(extensionIdOf(key)).toBe('knldjmfmopnpolahpmmgbagdohdnhkik')
  })

  test('the shipped extension pins one', async () => {
    const id = await new BrowserHostInstaller(options).extensionId()
    expect(id).toMatch(/^[a-p]{32}$/)
  })
})
