// Vim-style terminal escape: ctrl+\ ctrl+n. Runs inside xterm's custom key
// handler because xterm consumes modifier chords before the global keymap
// sees them. Returning false swallows the event (xterm never forwards it to
// the pty).

export interface TerminalKeyEvent {
  type: string
  key: string
  ctrlKey: boolean
}

export function createTerminalEscapeHandler(onEscape: () => void): (event: TerminalKeyEvent) => boolean {
  let escapePending = false

  return (event: TerminalKeyEvent): boolean => {
    if (event.type !== 'keydown') return true
    if (event.ctrlKey && event.key === '\\') {
      escapePending = true
      return false
    }
    if (escapePending && event.ctrlKey && event.key.toLowerCase() === 'n') {
      escapePending = false
      onEscape()
      return false
    }
    escapePending = false
    return true
  }
}
