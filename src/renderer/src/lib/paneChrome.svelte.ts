// The window controls every pane carries — switch type, split, maximize, close —
// live in the pane's own header row, like an OS title bar. PaneLeaf publishes
// which leaf they act on through context; a header claims them by rendering
// <PaneControls />. A pane whose header does not (or that has no header at the
// moment) gets them in its top-right corner from PaneLeaf instead. Either way
// they show only while the pointer is over the pane.

import { getContext, setContext } from 'svelte'

const PANE_CHROME = Symbol('pane-chrome')

export class PaneChrome {
  // How many headers inside the pane currently render the controls. Counted
  // rather than flagged because a header can come and go (an empty editor, a
  // terminal switching its tabs to the side).
  claims = $state(0)

  constructor(
    readonly leafId: string,
    readonly paneTypeId: () => string
  ) {}
}

/** Publishes the controls' leaf to everything inside it; null hides them from a subtree. */
export function providePaneChrome(chrome: PaneChrome | null): void {
  setContext(PANE_CHROME, chrome)
}

/** The leaf the controls act on, or null outside a pane (or inside a nested one). */
export function usePaneChrome(): PaneChrome | null {
  const chrome = getContext<PaneChrome | null | undefined>(PANE_CHROME)
  if (!chrome) {
    return null
  }
  return chrome
}
