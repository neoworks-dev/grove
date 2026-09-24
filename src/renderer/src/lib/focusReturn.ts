// Modal surfaces — the overlay picker, confirm dialogs — take the keyboard
// while they are open. When one closes, the element that held focus is
// removed with it and focus falls to <body>, where no key reaches anything,
// while the pane that was focused still looks it. This hands focus back.

import { keymap } from './keymap.svelte'

/**
 * Remembers where keyboard focus is now, and returns the function that hands it
 * back once the surface closes, given the surface's element. That only happens
 * if focus was dropped: an action that moved it on purpose — opening a file
 * into the editor — wins.
 */
export function rememberFocus(): (surface: HTMLElement | undefined) => void {
  const previous = document.activeElement
  return (surface) => {
    // After the closing action's own effects have had their turn to move focus.
    requestAnimationFrame(() => restoreFocus(previous, surface))
  }
}

/** Puts focus back on `previous`, or on the focused pane if that is gone. */
function restoreFocus(previous: Element | null, surface: HTMLElement | undefined): void {
  if (!focusWasDropped(surface)) return
  if (previous instanceof HTMLElement && previous.isConnected) {
    previous.focus({ preventScroll: true })
    if (document.activeElement === previous) return
  }
  const pane = keymap.activePane
  if (pane !== null) keymap.focusPane(pane)
}

/**
 * Whether focus is gone, or about to be: nothing holds it, or the closing
 * surface still does — it stays in the DOM, focused, for its exit transition.
 */
function focusWasDropped(surface: HTMLElement | undefined): boolean {
  const active = document.activeElement
  if (active === null || active === document.body) return true
  if (surface === undefined) return false
  return surface.contains(active)
}
