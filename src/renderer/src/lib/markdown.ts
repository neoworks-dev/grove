// Render agent messages (Markdown) to sanitized HTML for the chat view. marked
// handles GFM; DOMPurify strips anything unsafe before it reaches {@html}.

import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

// marked + DOMPurify cost a few ms per message. Transcript messages are stable
// strings, so a bounded LRU keeps remounts (view switches) and duplicate panes
// from re-parsing the same text. Streaming produces many transient partials,
// hence the cap and oldest-first eviction.
const CACHE_LIMIT = 500
const cache = new Map<string, string>()

export function renderMarkdown(text: string): string {
  const cached = cache.get(text)
  if (cached !== undefined) {
    // Refresh recency (Map preserves insertion order).
    cache.delete(text)
    cache.set(text, cached)
    return cached
  }
  const html = marked.parse(text, { async: false }) as string
  const clean = DOMPurify.sanitize(html)
  cache.set(text, clean)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return clean
}
