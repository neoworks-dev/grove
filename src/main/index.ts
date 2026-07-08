import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc, shutdown } from './ipc'

// Scale the whole UI with Ctrl/Cmd +, Ctrl/Cmd -, and Ctrl/Cmd 0 to reset.
// Electron performs no zoom on its own (no zoom-role menu), so drive it here.
function registerZoomShortcuts(window: BrowserWindow): void {
  const { webContents } = window
  const ZOOM_STEP = 0.5
  const ZOOM_MIN = -3
  const ZOOM_MAX = 3

  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (!input.control && !input.meta) return

    const zoomIn = input.code === 'Equal' || input.code === 'NumpadAdd'
    const zoomOut = input.code === 'Minus' || input.code === 'NumpadSubtract'
    const reset = input.code === 'Digit0' || input.code === 'Numpad0'
    if (!zoomIn && !zoomOut && !reset) return

    event.preventDefault()
    if (reset) {
      webContents.setZoomLevel(0)
      return
    }
    const delta = zoomIn ? ZOOM_STEP : -ZOOM_STEP
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, webContents.getZoomLevel() + delta))
    webContents.setZoomLevel(next)
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  registerZoomShortcuts(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Kill all supervised child processes before quitting.
app.on('before-quit', () => {
  void shutdown()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
