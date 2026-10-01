// "Connect Chrome": installs the browser extension's native-messaging host for
// a Chromium-family browser, on the user's explicit action and never on its own.
//
// Installing copies the host script and the unpacked extension out of the app
// into Grove's userData (an AppImage's resources live on a mount that changes
// every launch), writes a launcher that runs the host on Grove's own Electron
// binary, and writes the host manifest into the browser's NativeMessagingHosts
// directory with the extension's id in `allowed_origins`. Removing deletes the
// manifest. Windows registers hosts in the registry, which this doesn't do yet.

import { createHash } from 'crypto'
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { BrowserConnectorStatus, BrowserHostStatus, ChromiumBrowserId } from '../shared/browserHost'

/** The host's name, as the extension's `connectNative` asks for it. */
export const NATIVE_HOST_NAME = 'dev.neoworks.grove'

/** One browser the host can be installed for. */
export interface ChromiumBrowser {
  id: ChromiumBrowserId
  label: string
  // The browser's config directory, under XDG_CONFIG_HOME on Linux and
  // ~/Library/Application Support on macOS.
  linuxDirectory: string
  macDirectory: string
}

export const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  { id: 'chrome', label: 'Google Chrome', linuxDirectory: 'google-chrome', macDirectory: 'Google/Chrome' },
  { id: 'chromium', label: 'Chromium', linuxDirectory: 'chromium', macDirectory: 'Chromium' },
  { id: 'edge', label: 'Microsoft Edge', linuxDirectory: 'microsoft-edge', macDirectory: 'Microsoft Edge' },
  {
    id: 'brave',
    label: 'Brave',
    linuxDirectory: 'BraveSoftware/Brave-Browser',
    macDirectory: 'BraveSoftware/Brave-Browser'
  }
]

export interface BrowserHostInstallerOptions {
  platform: NodeJS.Platform
  /** The user's home directory (macOS paths hang off it). */
  home: string
  /** XDG_CONFIG_HOME, or ~/.config (Linux paths hang off it). */
  configHome: string
  /** Grove's userData: holds grove-api.json, and gets the host and extension copies. */
  userData: string
  /** The executable that runs the host as Node: Grove's own, or its AppImage. */
  electronBinary: string
  /** The bundled host script that ships with the app. */
  hostScript: string
  /** The unpacked extension that ships with the app. */
  extensionSource: string
}

/** Installs and removes the native-messaging host per browser. */
export class BrowserHostInstaller {
  private options: BrowserHostInstallerOptions

  constructor(options: BrowserHostInstallerOptions) {
    this.options = options
  }

  /** Where the host, its launcher, its token and the extension copy live. */
  get installDirectory(): string {
    return join(this.options.userData, 'browser-extension')
  }

  /** The launcher the manifests point Chrome at. */
  get launcherPath(): string {
    return join(this.installDirectory, 'grove-browser-host')
  }

  /** The unpacked extension the user loads into the browser. */
  get extensionPath(): string {
    return join(this.installDirectory, 'extension')
  }

  /** Whether this platform keeps hosts in files Grove can write. */
  get supported(): boolean {
    return this.options.platform === 'linux' || this.options.platform === 'darwin'
  }

  /** The host manifest's path for a browser on this platform. */
  manifestPath(browser: ChromiumBrowser): string {
    return join(this.browserDirectory(browser), 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
  }

  /** What is installed where. */
  async status(): Promise<BrowserConnectorStatus> {
    const browsers: BrowserHostStatus[] = []
    for (const browser of CHROMIUM_BROWSERS) {
      browsers.push({
        id: browser.id,
        label: browser.label,
        installed: this.supported && (await exists(this.manifestPath(browser))),
        detected: this.supported && (await exists(this.browserDirectory(browser))),
        manifestPath: this.manifestPath(browser)
      })
    }
    return {
      supported: this.supported,
      extensionPath: this.extensionPath,
      extensionCopied: await exists(join(this.extensionPath, 'manifest.json')),
      extensionId: await this.extensionId(),
      browsers
    }
  }

  /** Installs the host for one browser: copies host and extension, writes launcher and manifest. */
  async install(browserId: ChromiumBrowserId): Promise<BrowserConnectorStatus> {
    const browser = browserById(browserId)
    this.requireSupported()
    await this.copyFiles()
    const manifestPath = this.manifestPath(browser)
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, JSON.stringify(await this.hostManifest(), null, 2), 'utf8')
    return this.status()
  }

  /** Removes the host's manifest for one browser; the browser can't start the host after. */
  async remove(browserId: ChromiumBrowserId): Promise<BrowserConnectorStatus> {
    const browser = browserById(browserId)
    this.requireSupported()
    await rm(this.manifestPath(browser), { force: true })
    return this.status()
  }

  /**
   * Re-copies the host and extension when the host is installed for any
   * browser, so an updated Grove doesn't leave an old copy running. Installs
   * nothing that wasn't.
   */
  async refresh(): Promise<void> {
    if (!this.supported) return
    const status = await this.status()
    if (!status.browsers.some((browser) => browser.installed)) return
    await this.copyFiles()
  }

  /** The extension's id, derived from the public key pinned in its manifest. */
  async extensionId(): Promise<string> {
    const manifest = JSON.parse(await readFile(join(this.options.extensionSource, 'manifest.json'), 'utf8')) as {
      key?: unknown
    }
    if (typeof manifest.key !== 'string') throw new Error('the extension manifest has no key')
    return extensionIdOf(manifest.key)
  }

  // ── Plumbing ────────────────────────────────────────────────────

  /** A browser's config directory on this platform. */
  private browserDirectory(browser: ChromiumBrowser): string {
    if (this.options.platform === 'darwin') {
      return join(this.options.home, 'Library', 'Application Support', browser.macDirectory)
    }
    return join(this.options.configHome, browser.linuxDirectory)
  }

  /** Copies the host script and the extension, and writes the launcher. */
  private async copyFiles(): Promise<void> {
    await mkdir(this.installDirectory, { recursive: true, mode: 0o700 })
    await cp(this.options.hostScript, join(this.installDirectory, 'host.cjs'))
    await rm(this.extensionPath, { recursive: true, force: true })
    await cp(this.options.extensionSource, this.extensionPath, { recursive: true })
    await writeFile(this.launcherPath, this.launcher(), 'utf8')
    await chmod(this.launcherPath, 0o755)
  }

  /** The shell script Chrome starts: the host, on Grove's binary as Node, told which Grove to reach. */
  private launcher(): string {
    return [
      '#!/bin/sh',
      "# Written by Grove's \"Connect Chrome\". The browser starts this to reach Grove.",
      'export ELECTRON_RUN_AS_NODE=1',
      `export GROVE_API_DISCOVERY=${shellQuote(join(this.options.userData, 'grove-api.json'))}`,
      `export GROVE_BROWSER_TOKEN=${shellQuote(join(this.installDirectory, 'token'))}`,
      `exec ${shellQuote(this.options.electronBinary)} ${shellQuote(join(this.installDirectory, 'host.cjs'))} "$@"`,
      ''
    ].join('\n')
  }

  /** The native-messaging host manifest, allowing only Grove's extension. */
  private async hostManifest(): Promise<Record<string, unknown>> {
    return {
      name: NATIVE_HOST_NAME,
      description: 'Connects Grove’s browser extension to Grove',
      path: this.launcherPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${await this.extensionId()}/`]
    }
  }

  /** Fails on platforms whose hosts live in the registry. */
  private requireSupported(): void {
    if (this.supported) return
    throw new Error('Connecting a browser is only supported on Linux and macOS for now.')
  }
}

/**
 * A Chromium extension id from its manifest `key`: the first 128 bits of the
 * key's SHA-256, written in the letters a–p instead of hex digits.
 */
export function extensionIdOf(publicKeyBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex')
  let id = ''
  for (const digit of digest.slice(0, 32)) {
    id += String.fromCharCode('a'.charCodeAt(0) + parseInt(digit, 16))
  }
  return id
}

/** A browser by id, or an error for one Grove doesn't know. */
function browserById(browserId: ChromiumBrowserId): ChromiumBrowser {
  const browser = CHROMIUM_BROWSERS.find((candidate) => candidate.id === browserId)
  if (!browser) throw new Error(`unknown browser: ${String(browserId)}`)
  return browser
}

/** A string as one single-quoted shell word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
