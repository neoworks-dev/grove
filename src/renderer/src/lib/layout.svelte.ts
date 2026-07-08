// Per-repo UI layout: pane sizes and which panels are open. Restored on repo
// open and saved (debounced) to persisted repo state, alongside the center view
// and open tabs (read from the main store at save time). The last chat persists
// separately via agentSessions + transcript replay.

import { store } from './store.svelte'
import { activity } from './activity.svelte'

const DEFAULT_SIZES: Record<string, number> = {
  sidebar: 256,
  agent: 320,
  logs: 224,
  tree: 224,
  diffList: 256
}

class LayoutStore {
  paneSizes = $state<Record<string, number>>({ ...DEFAULT_SIZES })
  logsOpen = $state(true)

  private ready = false
  private timer: ReturnType<typeof setTimeout> | null = null

  size(key: string): number {
    return this.paneSizes[key] ?? DEFAULT_SIZES[key] ?? 256
  }

  setLogsOpen(open: boolean): void {
    this.logsOpen = open
    this.schedule()
  }

  // Restore from persisted repo state (once per repo open). Suppresses saving
  // until the restored values are in place.
  apply(state: {
    paneSizes?: Record<string, number>
    panelsOpen?: Record<string, boolean>
  }): void {
    this.ready = false
    this.paneSizes = { ...DEFAULT_SIZES, ...(state.paneSizes || {}) }
    this.logsOpen = state.panelsOpen?.logs ?? true
    this.ready = true
  }

  // Debounced persist. Also invoked by an App effect when the center view or
  // open tabs change, so one saver covers all layout state.
  schedule(): void {
    if (!this.ready) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 400)
  }

  private async flush(): Promise<void> {
    try {
      await window.workbench.state.update({
        paneSizes: this.paneSizes,
        panelsOpen: { logs: this.logsOpen },
        centerView: store.centerView,
        activeView: activity.activeView,
        openTabs: store.tabs.map((tab) => tab.path),
        activeTabPath: store.activeTabPath
      })
    } catch {
      // best-effort; layout is non-critical
    }
  }
}

export const layout = new LayoutStore()
