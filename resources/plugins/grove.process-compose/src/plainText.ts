// Raw terminal output as the text a person sees: escape sequences (colours,
// cursor moves, titles) dropped, and a line a progress bar redrew with \r
// reduced to what it last said. Used for copying output and for the last line
// a failed process printed. Shared by the worker and the page.

// CSI (colours, cursor), OSC (titles, links; ends in BEL or ST), and the
// two-character escapes left over.
const ESCAPE_SEQUENCES = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** The output as plain lines of text. */
export function plainText(output: string): string {
  return output
    .replace(ESCAPE_SEQUENCES, '')
    .split('\n')
    .map(lastRedraw)
    .join('\n')
}

/** The last line with anything on it, or '' when there is none. */
export function lastLine(output: string): string {
  const lines = plainText(output).split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line) return line
  }
  return ''
}

/** What a line says after its last carriage return, a line ending's aside. */
function lastRedraw(line: string): string {
  const withoutEnding = line.endsWith('\r') ? line.slice(0, -1) : line
  const at = withoutEnding.lastIndexOf('\r')
  if (at === -1) return withoutEnding
  return withoutEnding.slice(at + 1)
}
