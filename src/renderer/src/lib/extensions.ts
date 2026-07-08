// Renderer side of the extensions system. Loads installed grammars into the
// tree-sitter highlighter registry and installed themes into the color-theme
// registry, at startup and after an install/enable change.

import { registerHighlighter } from './highlighters'
import { initTreeSitter, loadGrammar, treeSitterExtension } from './treesitter'
import { registerTheme, basePalette, paletteFor, currentThemeName } from './themes'
import type { CatalogEntry } from '../../../shared/types'
import type { ThemePalette } from './themes'

async function registerGrammar(entry: CatalogEntry): Promise<void> {
  const payload = await window.workbench.extensions.grammar(entry.id)
  if (!payload) return
  const language = await loadGrammar(payload.wasm)
  registerHighlighter({
    id: entry.id,
    extensions: entry.extensions || [],
    priority: 200, // installed grammars beat bundled ones
    build: () => treeSitterExtension(language, payload.highlights, paletteFor(currentThemeName()))
  })
}

function registerCatalogTheme(entry: CatalogEntry): void {
  if (!entry.scheme) return
  const palette = { ...basePalette(entry.scheme), ...(entry.palette || {}) } as ThemePalette
  registerTheme({ name: entry.id, label: entry.name, scheme: entry.scheme, palette })
}

// Load every enabled installed extension into the renderer registries. Safe to
// call repeatedly — registration replaces by id/name.
export async function loadInstalledExtensions(): Promise<void> {
  const [catalog, installed] = await Promise.all([
    window.workbench.extensions.catalog(),
    window.workbench.extensions.installed()
  ])
  const byId = new Map(catalog.map((entry) => [entry.id, entry]))
  await initTreeSitter().catch(() => {})
  for (const record of installed) {
    if (!record.enabled) continue
    const entry = byId.get(record.id)
    if (!entry) continue
    try {
      if (entry.kind === 'grammar') await registerGrammar(entry)
      else if (entry.kind === 'theme') registerCatalogTheme(entry)
    } catch (error) {
      console.error(`failed to load extension ${entry.id}`, error)
    }
  }
}
