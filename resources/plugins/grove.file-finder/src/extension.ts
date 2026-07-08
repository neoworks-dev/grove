// Built-in file finder plugin: quick-open by filename. Dogfoods the plugin
// SDK — everything it does goes through the same sandboxed API third-party
// plugins use.

import * as grove from '@grove/plugin-sdk'

const RESULT_CAP = 200

// File list cache, invalidated each time the overlay opens.
let cachedFiles: string[] | null = null

export function activate(context: grove.PluginContext): void {
  context.subscriptions.push(
    grove.commands.register('files.find', () => {
      cachedFiles = null
      return grove.ui.overlays.open('fileFinder')
    }),

    grove.ui.overlays.setHandler('fileFinder', {
      async onQuery(query, emit, token) {
        if (!cachedFiles) cachedFiles = await grove.workspace.findFiles()
        if (token.isCancelled) return
        const needle = query.trim().toLowerCase()
        const hits = needle
          ? cachedFiles.filter((file) => file.toLowerCase().includes(needle))
          : cachedFiles
        emit(
          hits.slice(0, RESULT_CAP).map((file) => ({
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
