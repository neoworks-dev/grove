// The application's single keydown listener, wired to the focus model.
// Components subscribe here instead of adding their own window listener, so
// keyboard precedence is one ordered list rather than an emergent property of
// registration order and DOM phase.

import { keymap } from './keymap.svelte'
import { KeyDispatcher } from './keyDispatchCore'

export { KeyPriority, type KeyHandler } from './keyDispatchCore'

export const keyDispatch = new KeyDispatcher(() => keymap.activePane)

/**
 * Install the one window-level keydown listener. Capture phase is required so
 * grove's bindings beat the handlers Neovim and xterm attach to the focused
 * element. Returns a teardown function.
 */
export function startGlobalKeyDispatch(): () => void {
  function onWindowKeyDown(event: KeyboardEvent): void {
    keyDispatch.dispatch(event)
  }
  window.addEventListener('keydown', onWindowKeyDown, true)
  return () => window.removeEventListener('keydown', onWindowKeyDown, true)
}
