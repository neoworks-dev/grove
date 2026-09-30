// First-run setup of the editor's nvim profile, as the renderer sees it. Main
// runs it once before the first editor spawns (src/main/nvimSetup.ts); editor
// panes show its current step instead of a blank canvas while they wait.

import { dialogs } from '../dialogs.svelte'

// Long enough to read, since it names what failed and says what happens next.
const FAILURE_TOAST_MS = 10000

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
    window.workbench.on('event:nvim-setup-failed', (payload) => {
      const event = payload as { failedSteps?: unknown }
      reportSetupFailure(stepsOrEmpty(event.failedSteps))
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

/** Steps from IPC, keeping only the strings. */
function stepsOrEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((step): step is string => typeof step === 'string')
}

/**
 * Tells the user once that setup did not finish. Main sends this once per
 * launch; the editors start regardless, without what failed to install.
 */
function reportSetupFailure(failedSteps: string[]): void {
  let message = 'Editor setup did not finish. It tries again on the next launch.'
  if (failedSteps.length > 0) {
    message = `Editor setup failed: ${failedSteps.join(', ')}. It tries again on the next launch.`
  }
  dialogs.notify({ level: 'warn', message, timeoutMs: FAILURE_TOAST_MS })
}

export const nvimSetup = new NvimSetupState()
