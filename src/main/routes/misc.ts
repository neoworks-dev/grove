// Odds and ends that belong to no subsystem.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'

export const miscRoutes = {
  name: 'main/routes/misc',
  inject: [],

  apply(ctx: Context): void {
    // ── Misc ──────────────────────────────────────────────────────
    route(ctx, 'shell:openExternal', (_e: IpcMainInvokeEvent, url: string) =>
      shell.openExternal(url)
    )
    route(ctx, 'window:raise', (event: IpcMainInvokeEvent) => raiseWindow(event))
    route(ctx, 'window:controls', (event: IpcMainInvokeEvent) => windowControls(event))
    route(ctx, 'window:minimize', (event: IpcMainInvokeEvent) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize()
    })
    route(ctx, 'window:toggleFullScreen', (event: IpcMainInvokeEvent) =>
      toggleFullScreen(event)
    )
    route(ctx, 'window:close', (event: IpcMainInvokeEvent) => {
      BrowserWindow.fromWebContents(event.sender)?.close()
    })
  }
}

/** Brings the window that asked to the front, restoring it if it was minimised. */
function raiseWindow(event: IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) {
    return
  }
  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
}

// Tiling compositors have no minimised state to send a window to: minimize()
// is a silent no-op there. Electron cannot ask the compositor what it supports
// (Wayland's xdg_toplevel wm_capabilities is not exposed), so the desktop name
// is the best signal there is.
const TILING_DESKTOPS = [
  'hyprland',
  'sway',
  'i3',
  'niri',
  'river',
  'bspwm',
  'dwm',
  'qtile',
  'xmonad',
  'awesome',
  'herbstluftwm',
  'wayfire'
]

/** Whether the desktop the app runs on can minimise a window. */
function canMinimize(): boolean {
  if (process.platform !== 'linux') {
    return true
  }
  const desktops = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().split(':')
  return !desktops.some((desktop) => TILING_DESKTOPS.includes(desktop))
}

/** Which window controls the title bar should offer, and the fullscreen state. */
function windowControls(event: IpcMainInvokeEvent): {
  minimize: boolean
  fullScreen: boolean
  isFullScreen: boolean
} {
  const window = BrowserWindow.fromWebContents(event.sender)
  let isFullScreen = false
  if (window) {
    isFullScreen = window.isFullScreen()
  }
  return { minimize: canMinimize(), fullScreen: true, isFullScreen }
}

/** Flips the asking window in or out of fullscreen; resolves to the new state. */
function toggleFullScreen(event: IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) {
    return false
  }
  const next = !window.isFullScreen()
  window.setFullScreen(next)
  return next
}
