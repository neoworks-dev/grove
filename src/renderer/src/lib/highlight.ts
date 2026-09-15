// Syntax highlighting for code grove shows outside the editor.
//
// Inside a buffer, Neovim colours everything; a preview pane, a diff card or a
// search result is plain DOM, and was plain grey text. Shiki tokenizes with the
// same TextMate grammars the editor ecosystem uses, and the theme follows the
// app's light/dark scheme rather than shipping its own palette.
//
// Tokenizing is synchronous once a grammar is in memory, but loading one is not,
// so everything here is async and results are cached: previews re-render on
// every arrow key, and re-tokenizing the same excerpt per keypress would undo
// the point of it.

import { codeToTokens, bundledLanguages } from 'shiki'

/** One run of characters that share a colour. */
export interface HighlightedToken {
  text: string
  color: string
}

export type ColorScheme = 'dark' | 'light'

// Two themes, picked by the app's scheme. Their greys sit close enough to the
// design tokens that a highlighted excerpt reads as part of the window.
const THEMES: Record<ColorScheme, string> = {
  dark: 'github-dark',
  light: 'github-light'
}

// Excerpts repeat as the selection moves up and down a result list, so the same
// text is asked for again and again. Bounded, oldest-first, like the markdown
// cache next door.
const CACHE_LIMIT = 200
const cache = new Map<string, HighlightedToken[][]>()

/** Does shiki know this language, under the id `languageOfPath` gives? */
export function isHighlightable(language: string | undefined): boolean {
  if (!language) return false
  return language in bundledLanguages
}

/**
 * Tokenize code into one array of coloured runs per line.
 *
 * Returns null when the language is unknown or the grammar fails to load —
 * callers render the text plain rather than nothing.
 */
export async function highlightCode(
  code: string,
  language: string | undefined,
  scheme: ColorScheme
): Promise<HighlightedToken[][] | null> {
  if (!isHighlightable(language)) return null

  const key = `${scheme}:${language}:${code}`
  const cached = cache.get(key)
  if (cached) {
    // Refresh recency (Map preserves insertion order).
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const lines = await tokenize(code, language as string, scheme)
  if (!lines) return null

  cache.set(key, lines)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return lines
}

async function tokenize(
  code: string,
  language: string,
  scheme: ColorScheme
): Promise<HighlightedToken[][] | null> {
  try {
    const result = await codeToTokens(code, {
      lang: language,
      theme: THEMES[scheme]
    } as Parameters<typeof codeToTokens>[1])
    return result.tokens.map((line) =>
      line.map((token) => ({ text: token.content, color: token.color ?? '' }))
    )
  } catch {
    // An unknown or broken grammar must not cost the caller its content.
    return null
  }
}
