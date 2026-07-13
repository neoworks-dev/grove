// Renderer side of the extensions system. Loads installed themes into the
// color-theme registry, at startup and after an install/enable change.
// Installed grammars are consumed by the embedded Neovim (nvim-treesitter),
// not the renderer, so only themes are registered here.

import { registerTheme, basePalette } from './themes'
import type { CatalogEntry } from '../../../shared/types'
import type { ThemePalette } from './themes'

function registerCatalogTheme(entry: CatalogEntry): void {
  if (!entry.scheme) return
  const palette = { ...basePalette(entry.scheme), ...(entry.palette || {}) } as ThemePalette
  registerTheme({ name: entry.id, label: entry.name, scheme: entry.scheme, palette })
}

// Load every enabled installed theme into the renderer registry. Safe to call
// repeatedly — registration replaces by name.
export async function loadInstalledExtensions(): Promise<void> {
  const [catalog, installed] = await Promise.all([
    window.workbench.extensions.catalog(),
    window.workbench.extensions.installed()
  ])
  const byId = new Map(catalog.map((entry) => [entry.id, entry]))
  for (const record of installed) {
    if (!record.enabled) continue
    const entry = byId.get(record.id)
    if (!entry) continue
    if (entry.kind !== 'theme') continue
    try {
      registerCatalogTheme(entry)
    } catch (error) {
      console.error(`failed to load extension ${entry.id}`, error)
    }
  }
}
