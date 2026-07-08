// Highlighter plugin registry. Providers (e.g. installed tree-sitter grammars)
// register per file extension and take priority over CodeMirror's built-in Lezer
// languages, which remain the fallback (see `languageExtension` in editor.ts).
// Plugin-extensible, mirroring the commands/theme/activity registries.

import type { Extension } from '@codemirror/state'

export interface HighlighterProvider {
  id: string // language id, e.g. "rust"
  extensions: string[] // file extensions it handles, lowercase, no dot
  priority?: number // higher wins; tree-sitter providers use a high value
  build: () => Extension
}

const providers = new Map<string, HighlighterProvider>()
const listeners = new Set<() => void>()

// Grammars load asynchronously, so listeners (the editor) can re-apply the
// language once a provider appears.
export function onHighlightersChanged(callback: () => void): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notify(): void {
  for (const callback of listeners) callback()
}

export function registerHighlighter(provider: HighlighterProvider): () => void {
  providers.set(provider.id, provider)
  notify()
  return () => {
    providers.delete(provider.id)
    notify()
  }
}

export function availableHighlighters(): HighlighterProvider[] {
  return [...providers.values()]
}

// Highest-priority provider registered for the file's extension, or null.
export function resolveHighlighter(path: string): Extension | null {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  let best: HighlighterProvider | null = null
  for (const provider of providers.values()) {
    if (!provider.extensions.includes(ext)) continue
    if (!best || (provider.priority || 0) > (best.priority || 0)) best = provider
  }
  if (!best) return null
  // build() compiles the tree-sitter query, which throws if the query references
  // node types the (pinned) grammar lacks. Fall back to Lezer instead of letting
  // the editor reconfigure blow up.
  try {
    return best.build()
  } catch (error) {
    console.error(`highlighter ${best.id} failed to build; falling back`, error)
    return null
  }
}
