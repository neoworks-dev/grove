// User and project settings.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import type { IpcMainInvokeEvent } from 'electron'
import type { SettingScope } from '../../shared/settings'

export const settingsRoutes = {
  name: 'main/routes/settings',
  inject: ['workbench', 'settings'],

  apply(ctx: Context): void {
    // ── Settings ──────────────────────────────────────────────────
    route(ctx, 'settings:read', () => ctx.settings.snapshot())
    route(
      ctx,
      'settings:set',
      async (_e: IpcMainInvokeEvent, key: string, value: unknown, scope: SettingScope) => {
        const snapshot = await ctx.settings.set(key, value, scope)
        // Broadcast so every window (and future ones) stays coherent.
        ctx.workbench.send('event:settings-changed', snapshot)
        return snapshot
      }
    )
    route(ctx, 'settings:filePath', (_e: IpcMainInvokeEvent, scope: SettingScope) =>
      ctx.settings.ensureFile(scope)
    )
  }
}
