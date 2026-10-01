// Which language server runs a language, and from which binary. Pure, so the
// rule can be tested without Electron.

import type { CatalogEntry, InstalledExtension } from '../shared/types'

/** A catalog server for a language, with the binary that runs it. */
export interface LspServerChoice {
  entry: CatalogEntry
  executable: string
}

/**
 * The server to run for a language. One the user installed comes first; after
 * that, any catalog server whose binary is found — Mason's or one on PATH —
 * unless the user turned it off.
 */
export function chooseLspServer(
  language: string,
  catalog: CatalogEntry[],
  installed: InstalledExtension[],
  findExecutable: (name: string) => string | null
): LspServerChoice | null {
  const candidates = catalog.filter((entry) => entry.lsp?.languages.includes(language))
  const ordered = [
    ...candidates.filter((entry) => isEnabled(entry, installed)),
    ...candidates.filter((entry) => !installed.some((record) => record.id === entry.id))
  ]
  for (const entry of ordered) {
    const executable = findExecutable(entry.lsp!.command)
    if (executable) return { entry, executable }
  }
  return null
}

/** Whether the user installed a catalog entry and left it on. */
function isEnabled(entry: CatalogEntry, installed: InstalledExtension[]): boolean {
  return installed.some((record) => record.id === entry.id && record.enabled)
}
