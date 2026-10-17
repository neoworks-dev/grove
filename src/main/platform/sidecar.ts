// The sidecar host: Grove's main process running under Bun, without Electron, for the
// native app. The window, its dialogs and its URL schemes belong to the Rust host, so
// what the sidecar cannot do for itself is refused plainly instead of faked:
//
// - dialogs answer as a cancelled dialog would, which is the safe answer to "may this
//   run?" and "pick a folder";
// - custom URL schemes (grove-plugin, grove-agent, grove-file) are not served, so plugin
//   pages, agent attachments and media previews have nothing to load from yet;
// - there is no keychain, so credentials report "not storable" as on a Linux box with
//   no keyring running.

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Platform, RouteHandler } from './index'
import { openWithDefaultApp, readClipboardText, writeClipboardText } from './systemShell'

/** Where the transport hands routes and events to, so the platform stays free of stdio. */
export interface RouteTransport {
  handleRoute(channel: string, handler: RouteHandler): () => void
  broadcast(channel: string, payload: unknown): void
}

export interface SidecarPlatformOptions {
  transport: RouteTransport
  /** Overrides the data directory; by default `grove-native` under the XDG data home. */
  userDataPath?: string
  /** Overrides the checkout the app runs from; by default the one this file is in. */
  appPath?: string
  log?: (message: string) => void
}

/** The data directory: never Electron's, so the native app and the Electron app cannot collide. */
export function defaultUserDataPath(): string {
  const fromEnvironment = process.env.GROVE_SIDECAR_DATA
  if (fromEnvironment) {
    return fromEnvironment
  }
  const dataHome = process.env.XDG_DATA_HOME
  if (dataHome) {
    return join(dataHome, 'grove-native')
  }
  return join(homedir(), '.local', 'share', 'grove-native')
}

/** The checkout this file lives in, which has the `resources/` directory beside `src/`. */
function defaultAppPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/** The host that runs Grove's main process as the native app's sidecar. */
export function createSidecarPlatform(options: SidecarPlatformOptions): Platform {
  const userDataPath = options.userDataPath ?? defaultUserDataPath()
  const appPath = options.appPath ?? defaultAppPath()
  const log = options.log ?? ((message: string) => console.error(message))
  mkdirSync(userDataPath, { recursive: true })
  return {
    name: 'sidecar',
    userDataPath: () => userDataPath,
    isPackaged: () => false,
    appPath: () => appPath,
    handleRoute: (channel, handler) => options.transport.handleRoute(channel, handler),
    broadcast: (channel, payload) => options.transport.broadcast(channel, payload),
    showMessageBox: (messageBox) => {
      const answer = messageBox.buttons[messageBox.cancelId]
      log(`[sidecar] no dialog available, answering "${answer}": ${messageBox.title}`)
      return Promise.resolve(messageBox.cancelId)
    },
    pickDirectory: () => Promise.resolve(null),
    openExternal: async (url) => {
      const error = await openWithDefaultApp(url)
      if (error) {
        throw new Error(error)
      }
    },
    openPath: (path) => openWithDefaultApp(path),
    clipboard: { readText: readClipboardText, writeText: writeClipboardText },
    encryption: {
      isAvailable: () => false,
      encrypt: () => {
        throw new Error('the sidecar has no keychain to encrypt with')
      },
      decrypt: () => {
        throw new Error('the sidecar has no keychain to decrypt with')
      }
    },
    windowOf: () => null,
    evaluateInRenderer: () => Promise.reject(new Error('no renderer window is open')),
    handleProtocol: (scheme) => {
      log(`[sidecar] ${scheme}:// is not served by the sidecar`)
      return () => {}
    }
  }
}
