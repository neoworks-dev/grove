// Reading nib's event streams from the main process.
//
// The renderer gets `EventSource` for free; the main process does not, and the
// review bridge needs its own stream so a review keeps blocking the agent whether
// or not the agent pane is open. This is the subset of the SSE grammar nib
// actually emits: named events, a numeric id used as the resume cursor, and
// `: keepalive` comments every 15 seconds.

import type { Readable } from 'node:stream'

export interface SseFrame {
  // nib sets this to the event's sequence number; it is the `Last-Event-ID`
  // resume cursor.
  id: string | null
  event: string
  data: string
}

/**
 * Yield one frame per dispatched event. Ends when the stream does, which for nib
 * means the server went away — the caller decides whether to reconnect.
 */
export async function* readSse(stream: Readable): AsyncGenerator<SseFrame> {
  let buffer = ''
  let frame = emptyFrame()

  stream.setEncoding('utf8')
  for await (const chunk of stream as AsyncIterable<string>) {
    buffer += chunk

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)

      if (line.length > 0) {
        applyField(frame, line)
      } else if (frame.data.length > 0 || frame.event !== null) {
        yield dispatch(frame)
        frame = emptyFrame()
      }

      newline = buffer.indexOf('\n')
    }
  }
}

interface PartialFrame {
  id: string | null
  event: string | null
  data: string[]
}

function emptyFrame(): PartialFrame {
  return { id: null, event: null, data: [] }
}

function applyField(frame: PartialFrame, line: string): void {
  // A line starting with a colon is a comment; nib uses them as keepalives.
  if (line.startsWith(':')) return

  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  const raw = colon === -1 ? '' : line.slice(colon + 1)
  const value = raw.startsWith(' ') ? raw.slice(1) : raw

  if (field === 'id') frame.id = value
  else if (field === 'event') frame.event = value
  else if (field === 'data') frame.data.push(value)
}

function dispatch(frame: PartialFrame): SseFrame {
  return {
    id: frame.id,
    event: frame.event ?? 'message',
    data: frame.data.join('\n')
  }
}
