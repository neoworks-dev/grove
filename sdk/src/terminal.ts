// The xterm palette, read from Grove's theme tokens so a terminal matches the
// rest of Grove. Grove's own terminals use it, and so can a plugin page's: the
// pane connection puts the same tokens on the page (see pane.ts).

/** A CSS custom property's current value on the document, or the fallback. */
export function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** The xterm theme for the current app theme. */
export function terminalTheme(): Record<string, string> {
  const fg = cssVar('--text', '#fafafa')
  const dim = cssVar('--text-dim', '#71717a')
  return {
    background: cssVar('--surface', '#1c1c1e'),
    foreground: fg,
    cursor: fg,
    cursorAccent: cssVar('--surface', '#1c1c1e'),
    // The band nvim paints a Visual selection with, so selected text reads the
    // same in a terminal as it does in the editor.
    selectionBackground: cssVar('--border-strong', '#3f3f46'),
    black: cssVar('--surface', '#1c1c1e'),
    red: cssVar('--ctx-red', '#f87171'),
    green: cssVar('--ctx-green', '#a3e635'),
    yellow: cssVar('--ctx-amber', '#fbbf24'),
    blue: cssVar('--ctx-blue', '#60a5fa'),
    magenta: cssVar('--ctx-violet', '#a78bfa'),
    cyan: '#22d3ee',
    white: cssVar('--text-muted', '#a1a1aa'),
    brightBlack: dim,
    brightRed: cssVar('--ctx-red', '#f87171'),
    brightGreen: cssVar('--ctx-green', '#a3e635'),
    brightYellow: cssVar('--ctx-amber', '#fbbf24'),
    brightBlue: cssVar('--ctx-blue', '#60a5fa'),
    brightMagenta: cssVar('--ctx-violet', '#a78bfa'),
    brightCyan: '#67e8f9',
    brightWhite: fg
  }
}
