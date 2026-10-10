/**
 * The way into the rewind menu from outside the agent pane: the command palette
 * today, an Escape pressed twice in an empty prompt later. Each agent pane that is
 * showing registers how it opens its menu, and the newest one answers.
 */

const openers: (() => void)[] = []

/** Registers how a pane opens its rewind menu; returns the inverse. */
export function registerRewindMenuOpener(open: () => void): () => void {
  openers.push(open)
  return () => {
    const index = openers.indexOf(open)
    if (index >= 0) openers.splice(index, 1)
  }
}

/** Opens the rewind menu of the agent pane on screen; says whether a pane took it. */
export function openRewindMenu(): boolean {
  const open = openers[openers.length - 1]
  if (!open) return false
  open()
  return true
}
