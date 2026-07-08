// Render agent messages (Markdown) to sanitized HTML for the chat view. marked
// handles GFM; DOMPurify strips anything unsafe before it reaches {@html}.

import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html)
}
