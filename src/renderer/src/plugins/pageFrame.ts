// What every plugin page frame (file viewers, page panes) needs from Grove's
// side: the theme in the shape pages are promised, and replaying the keys a
// page passes up so Grove's own bindings still work while it has focus.

import type { PageKey, PageTheme } from '../../../shared/plugins'
import { currentThemeName, themeFor, themeTokens } from '../lib/themes'

// Tokens beyond the theme palette that pages need to look like Grove: the
// fonts, which the palette doesn't carry.
const FONT_TOKENS = ['--font-sans', '--font-mono']

/** The active theme in the shape a page is promised: a summary, and every design token. */
export function currentPageTheme(): PageTheme {
  const name = currentThemeName()
  const tokens = themeTokens(name)
  const style = getComputedStyle(document.documentElement)
  for (const token of FONT_TOKENS) tokens[token] = style.getPropertyValue(token).trim()
  const scheme = themeFor(name).scheme
  return {
    dark: scheme === 'dark',
    background: tokens['--bg'],
    surface: tokens['--surface'],
    text: tokens['--text'],
    textMuted: tokens['--text-muted'],
    border: tokens['--border'],
    accent: tokens['--primary'],
    scheme,
    tokens
  }
}

/**
 * Room Grove's pane controls take at the right end of a page pane's first row:
 * PluginPagePane draws the close button there (size-5, 17.5px at Grove's 14px
 * root) with a header's gap-2 (7px) before it, in line with a native header.
 */
export const PAGE_CONTROLS_INSET = 24.5

/**
 * Replays a key from a page as if pressed on its frame, so Grove's key
 * dispatch — which listens on the window — sees it. Keys inside a sandboxed
 * frame never reach this document on their own.
 */
export function replayPageKey(frame: HTMLIFrameElement | undefined, key: PageKey): void {
  const event = new KeyboardEvent('keydown', {
    key: key.key,
    code: key.code,
    ctrlKey: key.ctrlKey,
    altKey: key.altKey,
    shiftKey: key.shiftKey,
    metaKey: key.metaKey,
    bubbles: true,
    cancelable: true
  })
  frame?.dispatchEvent(event)
}
