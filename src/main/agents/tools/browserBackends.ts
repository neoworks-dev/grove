// Which browser the tool drives for a worktree: the provided tab (Kit, or
// Chrome through Grove's extension) serving it when there is one, the Electron
// Browser pane otherwise. The pane goes away in
// #354, and with it this choice.

import type { AgentBrowser } from './browserTools'

/** The Browser pane's side of the tool's interface: it opens through the UI, not on request. */
export type PaneBrowser = Omit<AgentBrowser, 'openTab'>

/** One `AgentBrowser` over both backends, preferring a provided tab per worktree. */
export function providerOrPane(providers: AgentBrowser, pane: PaneBrowser): AgentBrowser {
  /** The backend serving the worktree: the providers when one has a tab for it. */
  function servingBackend(worktreeId: string): PaneBrowser {
    if (providers.isAttached(worktreeId)) return providers
    return pane
  }

  return {
    isAttached: (worktreeId) => providers.isAttached(worktreeId) || pane.isAttached(worktreeId),
    waitForAttach: (worktreeId, timeoutMs) =>
      eitherAttaches(providers.waitForAttach(worktreeId, timeoutMs), pane.waitForAttach(worktreeId, timeoutMs)),
    openTab: (worktreeId, timeoutMs) => providers.openTab(worktreeId, timeoutMs),
    location: (worktreeId) => servingBackend(worktreeId).location(worktreeId),
    cdp: (worktreeId, method, params) => servingBackend(worktreeId).cdp(worktreeId, method, params),
    consoleLog: (worktreeId) => servingBackend(worktreeId).consoleLog(worktreeId),
    networkLog: (worktreeId) => servingBackend(worktreeId).networkLog(worktreeId)
  }
}

/** True as soon as either wait succeeds; false once both have given up. */
function eitherAttaches(first: Promise<boolean>, second: Promise<boolean>): Promise<boolean> {
  return new Promise((resolve) => {
    let waiting = 2
    const settle = (attached: boolean): void => {
      waiting -= 1
      if (attached) {
        resolve(true)
        return
      }
      if (waiting === 0) resolve(false)
    }
    void first.then(settle)
    void second.then(settle)
  })
}
