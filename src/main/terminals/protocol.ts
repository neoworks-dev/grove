// The wire between grove and the terminal daemon.
//
// The daemon outlives grove, so the two talk over a socket rather than through
// a parent/child pipe: one JSON object per line, in both directions. Terminal
// output is full of newlines and control bytes, which is why every payload goes
// through JSON encoding rather than being framed by hand.

import type { TerminalSessionInfo } from '../../shared/types'

export type { TerminalSessionInfo }

export type ClientMessage =
  | {
      type: 'create'
      /** Chosen by grove, so it can name the terminal before the daemon answers. */
      id: string
      cwd: string
      env: Record<string, string>
      cols: number
      rows: number
      worktreeId: string | null
    }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string }
  | { type: 'list'; requestId: string }
  /** Take over a terminal that outlived the last grove, and get its scrollback. */
  | { type: 'attach'; requestId: string; id: string; cols: number; rows: number }

export type DaemonMessage =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }
  | { type: 'title'; id: string; title: string }
  | { type: 'sessions'; requestId: string; sessions: TerminalSessionInfo[] }
  | { type: 'attached'; requestId: string; id: string; scrollback: string }

export function encode(message: ClientMessage | DaemonMessage): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Reassembles messages from a socket's chunks.
 *
 * A read boundary falls wherever the kernel puts it, so a chunk holds any number
 * of whole lines plus a partial one; the remainder is kept for the next chunk.
 */
export class LineDecoder {
  private remainder = ''

  push(chunk: string): unknown[] {
    const lines = (this.remainder + chunk).split('\n')
    this.remainder = lines.pop() ?? ''

    const messages: unknown[] = []
    for (const line of lines) {
      if (line.length === 0) continue
      const message = parse(line)
      if (message !== null) messages.push(message)
    }
    return messages
  }
}

/** A line that is not JSON is a protocol fault, not something to crash over. */
function parse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}
