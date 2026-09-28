// Reading a finished command back out of a terminal, from the shell's
// semantic-prompt markers (OSC 133): B where the typed command starts, C where
// it runs, D;<status> when it ends. Pure, over the few parts of xterm's buffer
// it reads, so it can be tested without a terminal.

/** The part of an xterm buffer line this reads. */
export interface BufferLineLike {
  isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

/** The part of an xterm buffer this reads. */
export interface BufferLike {
  getLine(y: number): BufferLineLike | undefined
}

/** A command that exited non-zero, and what it printed. */
export interface FailedCommand {
  command: string
  exitCode: number
  output: string
}

/** Most output lines kept: the end of a long log is where it says what broke. */
export const MAX_OUTPUT_LINES = 200

/**
 * The command line an OSC 133 C marker carries, or null when it carries none.
 * fish sends it URL-encoded as `cmdline_url=`, kitty's shell integration plain
 * as `cmdline=` — last, since the command itself can hold semicolons.
 */
export function commandFromMarker(data: string): string | null {
  const fields = data.split(';')
  for (let index = 1; index < fields.length; index++) {
    const field = fields[index]
    if (field.startsWith('cmdline_url=')) {
      return decodeCommand(field.slice('cmdline_url='.length))
    }
    if (field.startsWith('cmdline=')) {
      return fields.slice(index).join(';').slice('cmdline='.length)
    }
  }
  return null
}

/** A URL-encoded command line, or the raw text when it is not valid encoding. */
function decodeCommand(encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/**
 * The text of buffer lines `fromLine` through `toLine`, a line xterm wrapped
 * joined back to the one it continues, with the blank lines at the end dropped.
 */
export function readLines(buffer: BufferLike, fromLine: number, toLine: number): string[] {
  const lines: string[] = []
  for (let y = fromLine; y <= toLine; y++) {
    const line = buffer.getLine(y)
    if (!line) {
      continue
    }
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text
      continue
    }
    lines.push(text)
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }
  return lines
}

/**
 * What the user typed, when the shell does not send it with the C marker: from
 * the B marker's column to the line before the command ran.
 */
export function typedCommand(
  buffer: BufferLike,
  promptEnd: { line: number; column: number },
  outputStartLine: number
): string {
  const lines = readLines(buffer, promptEnd.line, Math.max(promptEnd.line, outputStartLine - 1))
  if (lines.length === 0) {
    return ''
  }
  lines[0] = lines[0].slice(promptEnd.column)
  return lines.join('\n').trim()
}

/** A command's output, the last MAX_OUTPUT_LINES of it, noting what was cut. */
export function commandOutput(buffer: BufferLike, fromLine: number, toLine: number): string {
  const lines = readLines(buffer, fromLine, toLine)
  if (lines.length <= MAX_OUTPUT_LINES) {
    return lines.join('\n')
  }
  const cut = lines.length - MAX_OUTPUT_LINES
  return [`… ${cut} earlier lines`, ...lines.slice(cut)].join('\n')
}
