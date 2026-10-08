// A ramble from the desktop overlay: what the user said while using their
// desktop, with what they did in brackets, and screenshots. The main process
// takes it off a local socket and hands it to the focused window, whose agent
// pane sends it to the worktree's agent.

export interface RambleImage {
  bytes: Uint8Array
  filename: string
}

/** Main to renderer: one ramble to send. */
export interface RambleDelivery {
  id: number
  text: string
  images: RambleImage[]
}

/** Renderer to main: where it went, or why it didn't. */
export interface RambleReceipt {
  sessionId: string | null
  error?: string
}
