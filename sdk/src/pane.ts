// For a plugin's pane page (`contributes.panes[].page`). The page runs in a
// sandboxed frame with no network and no Grove API; it draws whatever it likes
// and talks to its plugin's worker through this connection, where the worker
// side is `grove.panes.registerPage`. Import this from the page's own script,
// not from the worker — '@grove/plugin-sdk' itself only works there.
//
//   import { connectPane } from '@grove/plugin-sdk/pane'
//   const pane = connectPane({ onMessage: (data) => render(data) })
//   button.onclick = () => pane.post({ type: 'start' })
//
// Pages are meant to be Svelte with @neoworks-dev/ui, built with
// '@grove/plugin-sdk/vite' and styled from '@grove/plugin-sdk/page.css' — the
// same kit and tokens Grove's own panes use. The connection keeps them in
// Grove's live theme: it sets every design token Grove sends on :root
// (--surface, --text-dim, --ctx-green, --font-mono, …) and `data-theme` on
// <html>, so the kit's classes resolve to the colours around the pane. A
// small base stylesheet gives pages Grove's background, text and scrollbars
// even without the kit, at a specificity any rule of the page's own beats.
//
// Grove draws the pane's close button over the right end of the page's first
// row; --grove-pane-controls-inset is the room to leave it there, in px.

import type { PageTheme, PanePageMessage } from './protocol'
import { forwardUnhandledKeys } from './pageKeys'

export type { PageTheme } from './protocol'

export interface PaneHandlers {
  // Data the worker sent with `grove.panes.postMessage`.
  onMessage?: (data: unknown) => void
  // The theme arrived (once Grove answers) or changed.
  onTheme?: (theme: PageTheme) => void
}

export interface PaneConnection {
  // Sends data to the worker's PanePageHandler.onMessage. Must be
  // structured-cloneable; safe to call before Grove has answered.
  post(data: unknown): void
  // The current theme, once Grove has sent it.
  readonly theme: PageTheme | null
  dispose(): void
}

export function connectPane(handlers: PaneHandlers = {}): PaneConnection {
  let theme: PageTheme | null = null

  const setTheme = (next: PageTheme): void => {
    theme = next
    applyTheme(next)
    handlers.onTheme?.(next)
  }
  installBaseStyles()

  const listener = (event: MessageEvent): void => {
    // Only the frame's parent is Grove; anything else is not a message for us.
    if (event.source !== window.parent) return
    const message = event.data as PanePageMessage
    if (message?.type === 'grove.pane.init' || message?.type === 'grove.pane.theme') {
      if (message.type === 'grove.pane.init') {
        setPx('--grove-pane-controls-inset', message.controlsInset ?? 0)
      }
      setTheme(message.theme)
    } else if (message?.type === 'grove.pane.message') {
      handlers.onMessage?.(message.data)
    }
  }
  window.addEventListener('message', listener)
  const stopKeys = forwardUnhandledKeys((key) => send({ type: 'grove.pane.key', ...key }))
  send({ type: 'grove.pane.ready' })

  return {
    post: (data) => send({ type: 'grove.pane.message', data }),
    get theme() {
      return theme
    },
    dispose() {
      window.removeEventListener('message', listener)
      stopKeys()
    }
  }
}

/** Posts to Grove. The frame's parent origin is opaque from here, hence '*'. */
function send(message: PanePageMessage): void {
  window.parent.postMessage(message, '*')
}

/** Puts Grove's tokens and scheme on the page, so everything styled from them follows. */
function applyTheme(theme: PageTheme): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(theme.tokens ?? {})) {
    root.style.setProperty(name, value)
  }
  let scheme = theme.scheme
  if (scheme === undefined) scheme = theme.dark ? 'dark' : 'light'
  root.setAttribute('data-theme', scheme)
  root.style.setProperty('color-scheme', scheme)
}

function setPx(name: string, value: number): void {
  document.documentElement.style.setProperty(name, `${value}px`)
}

// Grove's own base look: what every pane has unless it says otherwise.
// :where() and bare pseudo-elements keep it below any rule of the page's.
const BASE_STYLES = `
:where(html) {
  background: var(--surface);
  color: var(--text);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
:where(body) { margin: 0; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: transparent; border-radius: 999px; border: 3px solid transparent; }
:hover::-webkit-scrollbar-thumb { background: var(--border-strong); background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: var(--text-dim); background-clip: padding-box; }
`

/** Puts the base styles first in <head>, so the page's own sheets come after. */
function installBaseStyles(): void {
  if (document.getElementById('grove-base-styles')) return
  const style = document.createElement('style')
  style.id = 'grove-base-styles'
  style.textContent = BASE_STYLES
  document.head.prepend(style)
}
