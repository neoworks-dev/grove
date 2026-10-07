// Key passing for plugin pages. A sandboxed frame keeps its keys to itself, so
// a page hands Grove the ones it leaves alone — the leader, pane navigation —
// and Grove replays them as if they had been pressed on the frame.

import type { PageKey } from './protocol'

/**
 * Listens for keys on the page and calls `send` with each one the page didn't
 * handle (called preventDefault) and that wasn't typed into a text field.
 * Returns the inverse.
 */
export function forwardUnhandledKeys(send: (key: PageKey) => void): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || isTextEntry(event.target)) return
    send({
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey
    })
  }
  window.addEventListener('keydown', listener)
  return () => window.removeEventListener('keydown', listener)
}

/** Whether keys aimed at `target` are text being typed. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}
