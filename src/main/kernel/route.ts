// Route registration as a kernel effect: every channel a route plugin installs
// carries the call that undoes it. Where the channel is served from (Electron's
// ipcMain, or the sidecar's stdio) is the platform's business.

import type { Context } from '@neoworks/extension-system'
import { platform, type RouteHandler } from '../platform'

export type IpcHandler = RouteHandler

/** Register one route channel for the lifetime of the calling fiber. */
export function route(ctx: Context, channel: string, handler: IpcHandler): void {
  ctx.effect(() => platform().handleRoute(channel, handler), `ipc:${channel}`)
}
