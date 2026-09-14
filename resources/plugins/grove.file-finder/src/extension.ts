// Built-in file finder plugin: quick-open by filename. Dogfoods the plugin
// SDK — everything it does goes through the same sandboxed API third-party
// plugins use.

import * as grove from '@grove/plugin-sdk'
import { rankFiles } from './rank'

// File list cache, invalidated each time the overlay opens.
let cachedFiles: string[] | null = null

/** The workspace file list, walked once per overlay open and reused per keystroke. */
async function loadFiles(): Promise<string[]> {
  if (cachedFiles) return cachedFiles
  const files = await grove.workspace.findFiles()
  cachedFiles = files
  return files
}

export function activate(context: grove.PluginContext): void {
  context.subscriptions.push(
    grove.commands.register('files.find', () => {
      cachedFiles = null
      return grove.ui.overlays.open('fileFinder')
    }),

    grove.ui.overlays.setHandler('fileFinder', {
      async onQuery(query, emit, token) {
        const files = await loadFiles()
        if (token.isCancelled) return
        const hits = rankFiles(files, query)
        emit(
          hits.map((file) => ({
            id: file,
            label: file,
            icon: `file:${file}`
          }))
        )
      },
      async onAccept(items) {
        const picked = items[0]
        if (picked) await grove.workspace.openFile(picked.id)
      }
    })
  )
}
