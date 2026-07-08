// Tiny facade between keybind AI actions and the agent pane: a prefill the
// pane consumes into its input (and focuses), set by 'ai-prompt' actions.

class AgentPromptStore {
  prefill = $state<string | null>(null)

  request(text: string): void {
    this.prefill = text
  }

  // The agent pane calls this once it has taken the text.
  consume(): string | null {
    const text = this.prefill
    this.prefill = null
    return text
  }
}

export const agentPrompt = new AgentPromptStore()
