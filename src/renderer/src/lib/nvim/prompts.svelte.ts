// The blocking prompts embedded Neovim sessions are currently stopped on.
// Sessions publish into this from their redraw handler and NvimPromptOverlay
// draws one, so a prompt is on screen and answerable even when focus sits in
// the terminal or the sidebar. See nvim/blockingPrompt.ts for what counts as
// blocked and why it has to be reachable from outside the pane.

export interface NvimBlockingPrompt {
  // The nvim session waiting for an answer; the overlay sends keys back to it.
  nvimId: string
  lines: string[]
}

class NvimPromptStore {
  prompts = $state<NvimBlockingPrompt[]>([])

  /** The prompt on screen: the one that has been waiting longest. */
  get active(): NvimBlockingPrompt | null {
    if (this.prompts.length === 0) return null
    return this.prompts[0]
  }

  /** Publish, or update in place, the prompt one session is blocked on. */
  set(nvimId: string, lines: string[]): void {
    const index = this.prompts.findIndex((prompt) => prompt.nvimId === nvimId)
    if (index === -1) {
      this.prompts = [...this.prompts, { nvimId, lines }]
      return
    }
    const next = [...this.prompts]
    next[index] = { nvimId, lines }
    this.prompts = next
  }

  /** The session answered its prompt, or went away. */
  clear(nvimId: string): void {
    if (!this.prompts.some((prompt) => prompt.nvimId === nvimId)) return
    this.prompts = this.prompts.filter((prompt) => prompt.nvimId !== nvimId)
  }
}

export const nvimPrompts = new NvimPromptStore()
