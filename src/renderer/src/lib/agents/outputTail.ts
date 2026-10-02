// The end of a command's output as plain text, for a preview under its call.
//
// Escape sequences (colour, cursor movement) and what a carriage return
// overwrote are for a terminal; a preview shows each line as it ended up.

// CSI (private markers `?<=>` included, as in `ESC [ > 0 q`), OSC, DCS, and
// the two-character escapes for character sets and keypad modes. A command
// in a pty sends all of these, a shell starting up most of all.
const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;?<=>]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001bP[^\u001b]*\u001b\\|\u001b[()][0-9A-Za-z]|\u001b[=>]/g

/** The last lines of the output as a terminal would leave them, without escapes. */
export function outputTail(text: string, lineCount: number): string[] {
  const lines = text.replace(ANSI_ESCAPE, '').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-lineCount).map(afterLastCarriageReturn)
}

/** What a line shows once every carriage return in it has rewritten it. */
function afterLastCarriageReturn(line: string): string {
  const trimmed = line.replace(/\r+$/, '')
  const index = trimmed.lastIndexOf('\r')
  if (index < 0) return trimmed
  return trimmed.slice(index + 1)
}
