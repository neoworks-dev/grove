// Odds and ends that belong to no subsystem.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { shell, type IpcMainInvokeEvent } from 'electron'

export const miscRoutes = {
  name: 'main/routes/misc',
  inject: [],

  apply(ctx: Context): void {
    // ── Misc ──────────────────────────────────────────────────────
    route(ctx, 'shell:openExternal', (_e: IpcMainInvokeEvent, url: string) =>
      shell.openExternal(url)
    )
  }
}
