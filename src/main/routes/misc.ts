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
