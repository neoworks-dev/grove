// IPC registration as a kernel effect: every channel a route plugin installs
// carries the removeHandler that undoes it.

import { ipcMain } from 'electron'
import type { Context } from '@neoworks/extension-system'

export type IpcHandler = Parameters<typeof ipcMain.handle>[1]

/** Register one IPC channel for the lifetime of the calling fiber. */
export function route(ctx: Context, channel: string, handler: IpcHandler): void {
  ctx.effect(() => {
    ipcMain.handle(channel, handler)
    return () => ipcMain.removeHandler(channel)
  }, `ipc:${channel}`)
}
