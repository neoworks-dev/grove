// First-run setup of the editor's nvim profile, as the renderer sees it. Main
// runs it once before the first editor spawns (src/main/nvimSetup.ts); editor
// panes show its current step instead of a blank canvas while they wait.

class NvimSetupState {
  /** The step setup is on, or null when none is running. */
  step = $state<string | null>(null)
  private watching = false

  /** Starts following setup's progress; later calls are no-ops. */
  watch(): void {
    if (this.watching) return
    this.watching = true
    window.workbench.on('event:nvim-setup', (payload) => {
      const event = payload as { step?: unknown }
      this.step = stepOrNull(event.step)
    })
    void window.workbench.nvim.setupStep().then((step) => {
      this.step = stepOrNull(step)
    })
  }
}

/** A step from IPC, or null when it isn't one. */
function stepOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

export const nvimSetup = new NvimSetupState()
