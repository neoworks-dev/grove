// Which terminals a pane has already taken over.
//
// Shells outlive grove, so every terminal pane that mounts asks the daemon what
// is still running and adopts what belongs to its worktree. With the panel split
// in two that question gets asked twice, and without a claim both panes would
// attach to the same shell and echo each other's keystrokes.

const claimed = new Set<string>()

/** Claim a terminal for a pane; false when another pane already has it. */
export function claimTerminal(id: string): boolean {
  if (claimed.has(id)) return false
  claimed.add(id)
  return true
}

/** Give a terminal back, so the next pane to mount can adopt it. */
export function releaseTerminal(id: string): void {
  claimed.delete(id)
}
