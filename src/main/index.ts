import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc, shutdown } from './ipc'
import { registerPluginScheme } from './plugins/protocol'

// Custom scheme privileges must be declared before app ready.
registerPluginScheme()

// LSP servers speak over stdio; when a server process dies mid-exchange,
// vscode-jsonrpc can still try to flush an internal reply to the destroyed
// stdin, rejecting with ERR_STREAM_DESTROYED from a write we do not own. That
// race is benign — swallow just that code and surface everything else.
process.on('unhandledRejection', (reason) => {
  const error = reason as NodeJS.ErrnoException | undefined
  if (error && error.code === 'ERR_STREAM_DESTROYED') return
  console.error('Unhandled promise rejection:', reason)
})

// Ctrl/Cmd +/-/0 are Chromium accelerators that zoom the whole page before the
// renderer's keydown ever fires. Intercept them here, cancel that built-in zoom,
// and forward the intent so the renderer can zoom only the focused pane. Matched
// by physical code and produced key so every keyboard layout and the numpad work.
function registerPaneZoomForwarding(window: BrowserWindow): void {
  const { webContents } = window
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (!input.control && !input.meta) return
    if (input.alt) return

    const zoomIn =
      input.code === 'Equal' ||
      input.code === 'NumpadAdd' ||
      input.key === '=' ||
      input.key === '+'
    const zoomOut =
      input.code === 'Minus' || input.code === 'NumpadSubtract' || input.key === '-'
    const reset = input.code === 'Digit0' || input.code === 'Numpad0' || input.key === '0'

    let direction: 'in' | 'out' | 'reset' | null = null
    if (zoomIn) direction = 'in'
    else if (zoomOut) direction = 'out'
    else if (reset) direction = 'reset'
    if (!direction) return

    event.preventDefault()
    webContents.send('event:pane-zoom', direction)
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

  registerPaneZoomForwarding(mainWindow)

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
