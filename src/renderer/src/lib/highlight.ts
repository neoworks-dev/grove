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

import {
  codeToTokens,
  bundledLanguages,
  createHighlighter,
  type BundledLanguage,
  type Highlighter
} from 'shiki'

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
    return runsOf(result.tokens)
  } catch {
    // An unknown or broken grammar must not cost the caller its content.
    return null
  }
}

/** Shiki's themed tokens as the coloured runs callers render. */
function runsOf(lines: { content: string; color?: string }[][]): HighlightedToken[][] {
  return lines.map((line) =>
    line.map((token) => ({ text: token.content, color: token.color ?? '' }))
  )
}

// ── Tokenizing without awaiting ─────────────────────────────────
//
// Text being typed cannot wait for a promise. The composer repaints its
// highlight layer on every keystroke, and one microtask per character is enough
// to show the text plain for a frame and then colour it — which reads as a
// flash. A highlighter instance tokenizes synchronously once its grammar is in
// memory, so callers warm the language once and paint in the same frame after.

let highlighterPromise: Promise<Highlighter> | null = null
let readyHighlighter: Highlighter | null = null
const loadedLanguages = new Set<string>()

function sharedHighlighter(): Promise<Highlighter> {
  if (highlighterPromise) return highlighterPromise
  highlighterPromise = createHighlighter({
    themes: [THEMES.dark, THEMES.light],
    langs: []
  }).then((highlighter) => {
    readyHighlighter = highlighter
    return highlighter
  })
  return highlighterPromise
}

/**
 * Load a grammar so `highlightCodeSync` can answer for it.
 *
 * True once the language is ready, false for one shiki does not know or cannot
 * load — callers that get false keep painting plain text.
 */
export async function warmLanguage(language: string | undefined): Promise<boolean> {
  if (!isHighlightable(language)) return false
  const name = language as string
  if (loadedLanguages.has(name)) return true
  try {
    const highlighter = await sharedHighlighter()
    await highlighter.loadLanguage(name as BundledLanguage)
    loadedLanguages.add(name)
    return true
  } catch {
    return false
  }
}

/**
 * Tokenize in this frame, or not at all.
 *
 * Null until `warmLanguage` has the grammar loaded, so the first paint is plain
 * and every one after it is coloured — no flicker between the two.
 */
export function highlightCodeSync(
  code: string,
  language: string | undefined,
  scheme: ColorScheme
): HighlightedToken[][] | null {
  const highlighter = readyHighlighter
  if (!highlighter || !language || !loadedLanguages.has(language)) return null
  try {
    const result = highlighter.codeToTokens(code, {
      lang: language as BundledLanguage,
      theme: THEMES[scheme]
    })
    return runsOf(result.tokens)
  } catch {
    return null
  }
}
