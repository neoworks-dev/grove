// The Electron host: every platform call is the Electron API it was before the seam
// existed. Takes the module as an argument, so nothing here imports `electron` and the
// tests can hand it their stub.

import type * as ElectronModule from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  MessageBoxOptions,
  Platform,
  ProtocolHandler,
  RouteHandler,
  WindowHandle
} from './index'

/** The host that runs Grove inside Electron's main process. */
export function createElectronPlatform(electron: typeof ElectronModule): Platform {
  return {
    name: 'electron',
    userDataPath: () => electron.app.getPath('userData'),
    isPackaged: () => electron.app.isPackaged,
    appPath: () => electron.app.getAppPath(),
    handleRoute: (channel, handler) => handleRoute(electron, channel, handler),
    broadcast: (channel, payload) => broadcast(electron, channel, payload),
    showMessageBox: (options) => showMessageBox(electron, options),
    pickDirectory: () => pickDirectory(electron),
    openExternal: (url) => electron.shell.openExternal(url),
    openPath: (path) => electron.shell.openPath(path),
    clipboard: {
      readText: () => electron.clipboard.readText(),
      writeText: (text) => electron.clipboard.writeText(text)
    },
    encryption: {
      isAvailable: () => electron.safeStorage.isEncryptionAvailable(),
      encrypt: (text) => electron.safeStorage.encryptString(text),
      decrypt: (encrypted) => electron.safeStorage.decryptString(encrypted)
    },
    windowOf: (event) => windowOf(electron, event),
    evaluateInRenderer: (expression) => evaluateInRenderer(electron, expression),
    handleProtocol: (scheme, handler) => handleProtocol(electron, scheme, handler)
  }
}

/** Registers the channel on ipcMain and returns the call that removes it. */
function handleRoute(
  electron: typeof ElectronModule,
  channel: string,
  handler: RouteHandler
): () => void {
  electron.ipcMain.handle(channel, handler)
  return () => electron.ipcMain.removeHandler(channel)
}

/** Sends the event to every open window's renderer. */
function broadcast(electron: typeof ElectronModule, channel: string, payload: unknown): void {
  for (const window of electron.BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

/** Shows the native message box and resolves to the index of the button pressed. */
async function showMessageBox(
  electron: typeof ElectronModule,
  options: MessageBoxOptions
): Promise<number> {
  const result = await electron.dialog.showMessageBox(options)
  return result.response
}

/** Shows the native directory picker; null when it is cancelled. */
async function pickDirectory(electron: typeof ElectronModule): Promise<string | null> {
  const result = await electron.dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

/** The window whose renderer made the call, if it still exists. */
function windowOf(electron: typeof ElectronModule, event: IpcMainInvokeEvent): WindowHandle | null {
  return electron.BrowserWindow.fromWebContents(event.sender)
}

/** Runs the script in the first window and resolves to what it returns. */
async function evaluateInRenderer(
  electron: typeof ElectronModule,
  expression: string
): Promise<unknown> {
  const window = electron.BrowserWindow.getAllWindows()[0]
  if (!window) {
    throw new Error('no renderer window is open')
  }
  return window.webContents.executeJavaScript(expression, true)
}

/** Serves the scheme through Electron's protocol module and returns the call that stops it. */
function handleProtocol(
  electron: typeof ElectronModule,
  scheme: string,
  handler: ProtocolHandler
): () => void {
  electron.protocol.handle(scheme, handler)
  return () => electron.protocol.unhandle(scheme)
}
