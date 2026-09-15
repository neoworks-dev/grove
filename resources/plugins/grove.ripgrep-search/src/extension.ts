// Built-in ripgrep search plugin: streams full-text matches into the overlay
// and previews an excerpt around the selected match.

import * as grove from '@grove/plugin-sdk'

interface Match {
  file: string
  line: number
  column: number
  text: string
}

const BATCH_SIZE = 50
/**
 * How many matches are worth asking for.
 *
 * The overlay draws every row it is given, and nobody reads past the first
 * screen of them; "const" in a monorepo matches often enough that delivering all
 * of it froze the window for minutes. The search still runs to the end — this is
 * how much of it comes back.
 */
const MAX_RESULTS = 200
// Enough context to fill the preview pane at any window height; the overlay
// centres the matched line, so the rest is there to be scrolled through rather
// than to be counted.
const CONTEXT_BEFORE = 40
const CONTEXT_AFTER = 40

export function activate(context: grove.PluginContext): void {
  context.subscriptions.push(
    grove.commands.register('search.files', () => grove.ui.overlays.open('ripgrep')),

    grove.ui.overlays.setHandler('ripgrep', {
      async onQuery(query, emit, token) {
        if (!query.trim()) return
        let batch: grove.OverlayItem[] = []
        for await (const match of grove.workspace.searchText(query, {
          token,
          limit: MAX_RESULTS
        })) {
          const typed = match as Match
          batch.push({
            id: `${typed.file}:${typed.line}:${typed.column}`,
            label: typed.file,
            description: `:${typed.line}`,
            detail: typed.text.trim(),
            icon: `file:${typed.file}`,
            data: typed
          })
          if (batch.length >= BATCH_SIZE) {
            emit(batch)
            batch = []
          }
          if (token.isCancelled) return
        }
        if (batch.length > 0) emit(batch)
      },

      async onPreview(item, token) {
        const match = item.data as Match
        const lines = await grove.workspace.readExcerpt(
          match.file,
          Math.max(1, match.line - CONTEXT_BEFORE),
          match.line + CONTEXT_AFTER
        )
        if (token.isCancelled) return null
        return { kind: 'excerpt', file: match.file, lines, highlightLine: match.line }
      },

      async onAccept(items) {
        const match = items[0]?.data as Match | undefined
        if (match) await grove.workspace.openFile(match.file, { line: match.line })
      }
    })
  )
}
