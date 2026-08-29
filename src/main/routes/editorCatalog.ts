// The editor catalog: downloadable grammars, themes and LSP server entries.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as editorCatalog from '../editorCatalog'

export const editorCatalogRoutes = {
  name: 'main/routes/editorCatalog',
  inject: [],

  apply(ctx: Context): void {
    // ── Editor catalog (grammars / themes / LSP servers) ──────────
    route(ctx, 'extensions:catalog', () => editorCatalog.listCatalog())
    route(ctx, 'extensions:installed', () => editorCatalog.listInstalled())
    route(ctx, 'extensions:install', (_e, id: string) => editorCatalog.install(id))
    route(ctx, 'extensions:uninstall', (_e, id: string) => editorCatalog.uninstall(id))
    route(ctx, 'extensions:setEnabled', (_e, id: string, enabled: boolean) =>
      editorCatalog.setEnabled(id, enabled)
    )
    route(ctx, 'extensions:grammar', (_e, id: string) => editorCatalog.readGrammar(id))
  }
}
