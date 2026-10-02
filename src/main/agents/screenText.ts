// What a command printed, as a person at its terminal would read it.
//
// In a terminal a progress bar redraws one line over and over, a spinner backs
// up a character at a time, and colour comes as escape sequences. Taking the
// escapes out of the raw output still leaves every frame of the bar; drawing
// the output in a terminal that is never shown, and reading back its text,
// leaves what was on screen at the end. That is what the model is given.

import { Terminal } from '@xterm/headless'

// Enough lines that the start of a long build is still there to quote; the
// model is given its start and its end.
const SCROLLBACK_LINES = 20_000

export class ScreenText {
  private terminal: Terminal

  constructor(cols: number, rows: number) {
    // Pipes end lines with \n alone, which a terminal takes as "down" without
    // "back to the start"; a pty's \r\n is unaffected.
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      convertEol: true,
      allowProposedApi: true
    })
  }

  /** Draws more of the command's output. */
  write(data: string): void {
    this.terminal.write(data)
  }

  /** Follows the command's terminal to a new size, from this point in its output on. */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows)
  }

  /**
   * The text on screen and in scrollback once everything written so far is
   * drawn: lines the terminal wrapped joined back up, trailing blanks dropped.
   */
  text(): Promise<string> {
    return new Promise((resolve) => {
      this.terminal.write('', () => resolve(this.readLines().join('\n')))
    })
  }

  /** Frees the terminal. */
  dispose(): void {
    this.terminal.dispose()
  }

  private readLines(): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index)
      if (!line) continue
      const text = line.translateToString(true)
      if (line.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text
        continue
      }
      lines.push(text)
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
  }
}
