// "Connect Chrome": installing and removing the browser extension's
// native-messaging host per browser, and showing the user the extension to load.

import type { Context } from '@neoworks/extension-system'
import { shell, type IpcMainInvokeEvent } from 'electron'
import { route } from '../kernel/route'
import type { ChromiumBrowserId } from '../../shared/browserHost'

export const browserHostRoutes = {
  name: 'main/routes/browser-host',
  inject: ['browserHost'],

  apply(ctx: Context): void {
    route(ctx, 'browserHost:status', () => ctx.browserHost.status())
    route(ctx, 'browserHost:install', (_event: IpcMainInvokeEvent, browser: ChromiumBrowserId) =>
      ctx.browserHost.install(browser)
    )
    route(ctx, 'browserHost:remove', (_event: IpcMainInvokeEvent, browser: ChromiumBrowserId) =>
      ctx.browserHost.remove(browser)
    )
    route(ctx, 'browserHost:revealExtension', async () => {
      const error = await shell.openPath(ctx.browserHost.extensionPath)
      if (error) throw new Error(error)
    })
  }
}
